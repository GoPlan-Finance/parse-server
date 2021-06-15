// @flow
// import Parse from 'parse/node';
const Parse = require('parse/node');
import { logger } from '../logger';
import Config from '../Config';
import { internalCreateSchema, internalUpdateSchema } from '../Routers/SchemasRouter';
import { defaultColumns, systemClasses } from '../Controllers/SchemaController';
import { ParseServerOptions } from '../Options';
import * as Migrations from './Migrations';

export class DefinedSchemas {
  config: ParseServerOptions;
  migrationOptions: Migrations.MigrationsOptions;
  localSchemas: Migrations.JSONSchema[];
  retries: number;
  maxRetries: number;

  constructor(migrationsOptions: Migrations.MigrationsOptions[], config: ParseServerOptions) {
    this.localSchemas = [];
    this.config = Config.get(config.appId);
    this.migrationsOptions = migrationsOptions;

    if (migrationsOptions && migrationsOptions.schemas) {
      this.localSchemas = migrationsOptions.schemas;
    }

    this.retries = 0;
    this.maxRetries = 3;
  }

  // Simulate save like the SDK
  // We cannot use SDK since routes are disabled
  async saveSchemaToDB(schema: Parse.Schema): Promise<void> {
    const payload = {
      className: schema.className,
      fields: schema._fields,
      indexes: schema._indexes,
      classLevelPermissions: schema._clp,
    };
    await internalCreateSchema(schema.className, payload, this.config);
    this.resetSchemaOps(schema);
  }

  resetSchemaOps(schema: Parse.Schema) {
    // Reset ops like SDK
    schema._fields = {};
    schema._indexes = {};
  }

  // Simulate update like the SDK
  // We cannot use SDK since routes are disabled
  async updateSchemaToDB(schema: Parse.Schema) {
    const payload = {
      className: schema.className,
      fields: schema._fields,
      indexes: schema._indexes,
      classLevelPermissions: schema._clp,
    };
    await internalUpdateSchema(schema.className, payload, this.config);
    this.resetSchemaOps(schema);
  }

  async execute() {
    let timeout = null;
    try {
      // Set up a time out in production
      // if we fail to get schema
      // pm2 or K8s and many other process managers will try to restart the process
      // after the exit
      if (process.env.NODE_ENV === 'production') {
        timeout = setTimeout(() => {
          logger.error('Timeout occurred during execution of migrations. Exiting...');
          process.exit(1);
        }, 20000);
      }

      // Hack to force session schema to be created
      await this.createDeleteSession();
      this.allCloudSchemas = await Parse.Schema.all();
      clearTimeout(timeout);
      await Promise.all(this.localSchemas.map(async localSchema => this.saveOrUpdate(localSchema)));

      this.checkForMissingSchemas();
      await this.enforceCLPForNonProvidedClass();
    } catch (e) {
      if (timeout) clearTimeout(timeout);
      if (this.retries < this.maxRetries) {
        this.retries++;
        // first retry 1sec, 2sec, 3sec total 6sec retry sequence
        // retry will only happen in case of deploying multi parse server instance
        // at the same time
        // modern systems like k8 avoid this by doing rolling updates
        await this.wait(1000 * this.retries);
        await this.execute();
      } else {
        logger.error(e);
        if (process.env.NODE_ENV === 'production') process.exit(1);
      }
    }
  }

  checkForMissingSchemas() {
    if (this.migrationsOptions.strict !== true) {
      return;
    }

    const cloudSchemas = this.allCloudSchemas.map(s => s.className);
    const localSchemas = this.localSchemas.map(s => s.className);
    const missingSchemas = cloudSchemas.filter(
      c => !localSchemas.includes(c) && !systemClasses.includes(c)
    );

    if (missingSchemas.length) {
      logger.warn(
        `The following schemas are currently present in the database, but not explicitly defined in a schema: "${missingSchemas.join(
          '", "'
        )}"`
      );
    }
  }

  // Required for testing purpose
  async wait(time) {
    await new Promise(resolve => setTimeout(resolve, time));
  }

  async enforceCLPForNonProvidedClass(): void {
    const nonProvidedClasses = this.allCloudSchemas.filter(
      cloudSchema =>
        !this.localSchemas.some(localSchema => localSchema.className === cloudSchema.className)
    );
    await Promise.all(
      nonProvidedClasses.map(async schema => {
        const parseSchema = new Parse.Schema(schema.className);
        this.handleCLP(schema, parseSchema);
        await this.updateSchemaToDB(parseSchema);
      })
    );
  }

  // Create a fake session since Parse do not create the _Session until
  // a session is created
  async createDeleteSession() {
    const session = new Parse.Session();
    await session.save(null, { useMasterKey: true });
    await session.destroy({ useMasterKey: true });
  }

  async saveOrUpdate(localSchema: Migrations.JSONSchema) {
    const cloudSchema = this.allCloudSchemas.find(sc => sc.className === localSchema.className);
    if (cloudSchema) {
      try {
        await this.updateSchema(localSchema, cloudSchema);
      } catch (e) {
        logger.error(`Error during update of schema for type ${cloudSchema.className}: ${e}`);
        throw e;
      }
    } else {
      try {
        await this.saveSchema(localSchema);
      } catch (e) {
        logger.error(`Error while saving Schema for type ${cloudSchema.className}: ${e}`);
        throw e;
      }
    }
  }

  async saveSchema(localSchema: Migrations.JSONSchema) {
    const newLocalSchema = new Parse.Schema(localSchema.className);
    if (localSchema.fields) {
      // Handle fields
      Object.keys(localSchema.fields)
        .filter(fieldName => !this.isProtectedFields(localSchema.className, fieldName))
        .forEach(fieldName => {
          const field = localSchema.fields[fieldName];
          this.handleFields(newLocalSchema, fieldName, field);
        });
    }
    // Handle indexes
    if (localSchema.indexes) {
      Object.keys(localSchema.indexes).forEach(indexName => {
        if (!this.isProtectedIndex(localSchema.className, indexName)) {
          newLocalSchema.addIndex(indexName, localSchema.indexes[indexName]);
        }
      });
    }

    this.handleCLP(localSchema, newLocalSchema);

    return this.saveSchemaToDB(newLocalSchema);
  }

  async updateSchema(localSchema: Migrations.JSONSchema, cloudSchema: Parse.Schema) {
    const newLocalSchema = new Parse.Schema(localSchema.className);

    // Handle fields
    // Check addition
    if (localSchema.fields) {
      Object.keys(localSchema.fields)
        .filter(fieldName => !this.isProtectedFields(localSchema.className, fieldName))
        .forEach(fieldName => {
          const field = localSchema.fields[fieldName];
          if (!cloudSchema.fields[fieldName]) this.handleFields(newLocalSchema, fieldName, field);
        });
    }

    const fieldsToDelete: string[] = [];
    const fieldsToRecreate: {
      fieldName: string,
      from: { type: string, targetClass: string },
      to: { type: string, targetClass: string },
    }[] = [];
    const fieldsWithChangedParams: string[] = [];

    // Check deletion
    Object.keys(cloudSchema.fields)
      .filter(fieldName => !this.isProtectedFields(localSchema.className, fieldName))
      .forEach(fieldName => {
        const field = cloudSchema.fields[fieldName];
        if (!localSchema.fields || !localSchema.fields[fieldName]) {
          fieldsToDelete.push(fieldName);
          return;
        }

        const localField = localSchema.fields[fieldName];
        // Check if field has a changed type
        if (
          !this.paramsAreEquals(
            { type: field.type, targetClass: field.targetClass },
            { type: localField.type, targetClass: localField.targetClass }
          )
        ) {
          fieldsToRecreate.push({
            fieldName,
            from: { type: field.type, targetClass: field.targetClass },
            to: { type: localField.type, targetClass: localField.targetClass },
          });
          return;
        }

        // Check if something changed other than the type (like required, defaultValue)
        if (!this.paramsAreEquals(field, localField)) {
          fieldsWithChangedParams.push(fieldName);
        }
      });

    if (this.migrationsOptions.deleteExtraFields === true) {
      fieldsToDelete.forEach(fieldName => {
        newLocalSchema.deleteField(fieldName);
      });

      // Delete fields from the schema then apply changes
      await this.updateSchemaToDB(newLocalSchema);
    } else if (this.migrationsOptions.strict === true && fieldsToDelete.length) {
      logger.warn(
        `The following fields exist in the database for "${
          localSchema.className
        }", but are missing in the schema : "${fieldsToDelete.join('" ,"')}"`
      );
    }

    if (this.migrationsOptions.recreateModifiedFields === true) {
      fieldsToRecreate.forEach(fieldName => {
        newLocalSchema.deleteField(fieldName);
      });

      // Delete fields from the schema then apply changes
      await this.updateSchemaToDB(newLocalSchema);

      fieldsToRecreate.forEach(fieldName => {
        const field = localSchema.fields[fieldName];
        this.handleFields(newLocalSchema, fieldName, field);
      });
    } else if (this.migrationsOptions.strict === true && fieldsToRecreate.length) {
      fieldsToRecreate.forEach(field => {
        const from =
          field.from.type + (field.from.targetClass ? ` (${field.from.targetClass})` : '');
        const to = field.to.type + (field.to.targetClass ? ` (${field.to.targetClass})` : '');

        logger.warn(
          `The field "${field.fieldName}" type differ between the schema and the database for "${localSchema.className}"; Schema is defined as "${to}" and current database type is "${from}"`
        );
      });
    }

    fieldsWithChangedParams.forEach(fieldName => {
      const field = localSchema.fields[fieldName];
      this.handleFields(newLocalSchema, fieldName, field);
    });

    // Handle Indexes
    // Check addition
    if (localSchema.indexes) {
      Object.keys(localSchema.indexes).forEach(indexName => {
        if (
          (!cloudSchema.indexes || !cloudSchema.indexes[indexName]) &&
          !this.isProtectedIndex(localSchema.className, indexName)
        )
          newLocalSchema.addIndex(indexName, localSchema.indexes[indexName]);
      });
    }

    const indexesToAdd = [];

    // Check deletion
    if (cloudSchema.indexes) {
      Object.keys(cloudSchema.indexes).forEach(indexName => {
        if (!this.isProtectedIndex(localSchema.className, indexName)) {
          if (!localSchema.indexes || !localSchema.indexes[indexName]) {
            newLocalSchema.deleteIndex(indexName);
          } else if (
            !this.paramsAreEquals(localSchema.indexes[indexName], cloudSchema.indexes[indexName])
          ) {
            newLocalSchema.deleteIndex(indexName);
            indexesToAdd.push({
              indexName,
              index: localSchema.indexes[indexName],
            });
          }
        }
      });
    }

    this.handleCLP(localSchema, newLocalSchema, cloudSchema);
    // Apply changes
    await this.updateSchemaToDB(newLocalSchema);
    // Apply new/changed indexes
    if (indexesToAdd.length) {
      logger.debug(
        `Updating indexes for "${newLocalSchema.className}" :  ${indexesToAdd.join(' ,')}`
      );
      indexesToAdd.forEach(o => newLocalSchema.addIndex(o.indexName, o.index));
      await this.updateSchemaToDB(newLocalSchema);
    }
  }

  handleCLP(localSchema: Migrations.JSONSchema, newLocalSchema: Parse.Schema, cloudSchema) {
    if (!localSchema.classLevelPermissions && !cloudSchema) {
      logger.warn(`classLevelPermissions not provided for ${localSchema.className}.`);
    }
    // Use spread to avoid read only issue (encountered by Moumouls using directAccess)
    const clp = { ...localSchema.classLevelPermissions } || {};
    const cloudCLP = (cloudSchema && cloudSchema.classLevelPermissions) || {};
    // Try to inject default CLPs
    const CLPKeys = ['find', 'count', 'get', 'create', 'update', 'delete', 'addField'];
    CLPKeys.forEach(key => {
      if (!clp[key]) {
        clp[key] = cloudCLP[key] || { '*': false };
      }
    });
    // To avoid inconsistency we need to remove all rights on addField
    clp.addField = {};
    newLocalSchema.setCLP(clp);
  }

  isProtectedFields(className, fieldName) {
    return (
      !!defaultColumns._Default[fieldName] ||
      !!(defaultColumns[className] && defaultColumns[className][fieldName])
    );
  }

  isProtectedIndex(className, indexName) {
    let indexes = ['_id_'];
    if (className === '_User') {
      indexes = [
        ...indexes,
        'case_insensitive_username',
        'case_insensitive_email',
        'username_1',
        'email_1',
      ];
    }

    return indexes.indexOf(indexName) !== -1;
  }

  paramsAreEquals<T>(objA: T, objB: T) {
    const keysA = Object.keys(objA);
    const keysB = Object.keys(objB);

    // Check key name
    if (keysA.length !== keysB.length) return false;
    return keysA.every(k => objA[k] === objB[k]);
  }

  handleFields(newLocalSchema: Parse.Schema, fieldName: string, field: Migrations.FieldType) {
    if (field.type === 'Relation') {
      newLocalSchema.addRelation(fieldName, field.targetClass);
    } else if (field.type === 'Pointer') {
      newLocalSchema.addPointer(fieldName, field.targetClass, field);
    } else {
      newLocalSchema.addField(fieldName, field.type, field);
    }
  }
}
