var Utils     = require("./utils")
  , DAO       = require("./dao")
  , DataTypes = require("./data-types")

module.exports = (function() {
  var DAOFactory = function(name, attributes, options) {
    var self = this

    this.options = Utils._.extend({
      timestamps: true,
      instanceMethods: {},
      classMethods: {},
      validate: {},
      freezeTableName: false,
      underscored: false,
      syncOnAssociation: true,
      paranoid: false
    }, options || {})

    this.name = name
    this.tableName = this.options.freezeTableName ? name : Utils.pluralize(name)
    this.rawAttributes = attributes
    this.daoFactoryManager = null // defined in init function
    this.associations = {}

    // extract validation
    this.validate = this.options.validate || {}
  }

  Object.defineProperty(DAOFactory.prototype, 'attributes', {
    get: function() {
      return this.QueryGenerator.attributesToSQL(this.rawAttributes)
    }
  })

  Object.defineProperty(DAOFactory.prototype, 'QueryInterface', {
    get: function() { return this.daoFactoryManager.sequelize.getQueryInterface() }
  })

  Object.defineProperty(DAOFactory.prototype, 'QueryGenerator', {
    get: function() { return this.QueryInterface.QueryGenerator }
  })

  Object.defineProperty(DAOFactory.prototype, 'primaryKeyCount', {
    get: function() { return Utils._.keys(this.primaryKeys).length }
  })

  Object.defineProperty(DAOFactory.prototype, 'hasPrimaryKeys', {
    get: function() { return this.primaryKeyCount > 0 }
  })

  DAOFactory.prototype.init = function(daoFactoryManager) {
    this.daoFactoryManager = daoFactoryManager

    addDefaultAttributes.call(this)
    addOptionalClassMethods.call(this)
    findAutoIncrementField.call(this)

    return this
  }

  DAOFactory.prototype.sync = function(options) {
    options = Utils._.extend({}, this.options, options || {})

    var self = this
    return new Utils.CustomEventEmitter(function(emitter) {
      var doQuery = function() {
        self.QueryInterface
          .createTable(self.tableName, self.attributes, options)
          .success(function() { emitter.emit('success', self) })
          .error(function(err) { emitter.emit('error', err) })
          .on('sql', function(sql) { emitter.emit('sql', sql) })
      }

      if(options.force)
        self.drop().success(doQuery).error(function(err) { emitter.emit('error', err) })
      else
        doQuery()

    }).run()
  }

  DAOFactory.prototype.drop = function() {
    return this.QueryInterface.dropTable(this.tableName)
  }

  // alias for findAll
  DAOFactory.prototype.all = function(options) {
    return this.findAll(options)
  }

  DAOFactory.prototype.findAll = function(options) {
    var hasJoin = false;

    if ((typeof options === 'object') && (options.hasOwnProperty('include'))) {
      var includes = options.include

      hasJoin = true;
      options.include = {}

      includes.forEach(function(daoName) {
        options.include[daoName] = this.daoFactoryManager.getDAO(daoName)
      }.bind(this))
    }

    return this.QueryInterface.select(this, this.tableName, options, { type: 'SELECT', hasJoin: hasJoin })
  }

  //right now, the caller (has-many-double-linked) is in charge of the where clause
  DAOFactory.prototype.findAllJoin = function(joinTableName, options) {
    var optcpy = Utils._.clone(options)
    optcpy.attributes = optcpy.attributes || [Utils.addTicks(this.tableName)+".*"]

    return this.QueryInterface.select(this, [this.tableName, joinTableName], optcpy, { type: 'SELECT' })
  }

  DAOFactory.prototype.find = function(options) {
    var hasJoin = false;
    // no options defined?
    // return an emitter which emits null
    if([null, undefined].indexOf(options) !== -1) {
      return new Utils.CustomEventEmitter(function(emitter) {
        setTimeout(function() { emitter.emit('success', null) }, 10)
      }).run()
    }

    var primaryKeys = this.primaryKeys;

    // options is not a hash but an id
    if(typeof options === 'number') {
      options = { where: options }
    } else if (Utils._.size(primaryKeys) && Utils.argsArePrimaryKeys(arguments, primaryKeys)) {
      var where = {}
        , self  = this
        , keys = Utils._.keys(primaryKeys)

      Utils._.each(arguments, function(arg, i) {
        var key = keys[i]
        where[key] = arg
      })

      options = { where: where }
    } else if ((typeof options === 'string') && (parseInt(options, 10).toString() === options)) {
      var parsedId = parseInt(options, 10);

      if(!Utils._.isFinite(parsedId)) {
        throw new Error('Invalid argument to find(). Must be an id or an options object.')
      }

      options = { where: parsedId }
    } else if ((typeof options === 'object') && (options.hasOwnProperty('include'))) {
      var includes = options.include
      hasJoin = true;

      options.include = {}

      includes.forEach(function(daoName) {
        options.include[daoName] = this.daoFactoryManager.getDAO(daoName)
      }.bind(this))
    }

    options.limit = 1

    return this.QueryInterface.select(this, this.tableName, options, { plain: true, type: 'SELECT', hasJoin: hasJoin })
  }

  DAOFactory.prototype.count = function(options) {
    options = Utils._.extend({ attributes: [] }, options || {})
    options.attributes.push(['count(*)', 'count'])
    options.parseInt = true

    return this.QueryInterface.rawSelect(this.tableName, options, 'count')
  }

  DAOFactory.prototype.max = function(field, options) {
    options = Utils._.extend({ attributes: [] }, options || {})
    options.attributes.push(['max(' + field + ')', 'max'])
    options.parseInt = true

    return this.QueryInterface.rawSelect(this.tableName, options, 'max')
  }
  DAOFactory.prototype.min = function(field, options) {
    options = Utils._.extend({ attributes: [] }, options || {})
    options.attributes.push(['min(' + field + ')', 'min'])
    options.parseInt = true

    return this.QueryInterface.rawSelect(this.tableName, options, 'min')
  }

  DAOFactory.prototype.build = function(values, options) {
    var instance = new DAO(values, Utils._.extend(this.options, { hasPrimaryKeys: this.hasPrimaryKeys, factory: this }))
      , self     = this

    options = options || {}
    instance.__factory = this

    Utils._.each(this.attributes, function(definition, name) {
      //transform integer 0,1 into boolean
      if((definition.indexOf(DataTypes.BOOLEAN) !== -1) && (typeof instance[name] === "number")) {
        instance[name] = (instance[name] !== 0)
      }

      //add default attributes
      if(typeof instance[name] === 'undefined') {
        var value = null

        if(self.rawAttributes.hasOwnProperty(name) && self.rawAttributes[name].hasOwnProperty('defaultValue')) {
          value = Utils.toDefaultValue(self.rawAttributes[name].defaultValue)
        }

        instance[name] = value
        instance.addAttribute(name, value)
      }

      // add validation
      if (self.rawAttributes.hasOwnProperty(name) && self.rawAttributes[name].hasOwnProperty('validate')) {
        instance.setValidators(name, self.rawAttributes[name].validate)
      }
    })

    Utils._.each(this.options.instanceMethods || {}, function(fct, name) { instance[name] = fct })
    Utils._.each(this.associations, function(association) {
      association.injectGetter(instance)
      association.injectSetter(instance)
    })

    instance.isNewRecord    = options.hasOwnProperty('isNewRecord') ? options.isNewRecord : true
    instance.selectedValues = values

    return instance
  }

  DAOFactory.prototype.create = function(values, fields) {
    return this.build(values).save(fields)
  }

  DAOFactory.prototype.__defineGetter__('primaryKeys', function() {
    var result = {}
    Utils._.each(this.attributes, function(dataTypeString, attributeName) {
      if((attributeName != 'id') && (dataTypeString.indexOf('PRIMARY KEY') !== -1)) {
        result[attributeName] = dataTypeString
      }
    })

    return result
  })

  // private

  var query = function() {
    var args      = Utils._.map(arguments, function(arg, _) { return arg })
      , sequelize = this.daoFactoryManager.sequelize

    // add this as the second argument
    if (arguments.length === 1) {
      args.push(this)
    }

    // add {} as options
    if (args.length === 2) {
      args.push({})
    }

    return sequelize.query.apply(sequelize, args)
  }

  var addOptionalClassMethods = function() {
    var self = this
    Utils._.each(this.options.classMethods || {}, function(fct, name) { self[name] = fct })
  }

  var addDefaultAttributes = function() {
    var self              = this
      , defaultAttributes = {
        id: {
          type: DataTypes.INTEGER,
          allowNull: false,
          primaryKey: true,
          autoIncrement: true
        }
      }

    if(this.hasPrimaryKeys) defaultAttributes = {}

    if(this.options.timestamps) {
      defaultAttributes[Utils._.underscoredIf('createdAt', this.options.underscored)] = {type: DataTypes.DATE, allowNull: false}
      defaultAttributes[Utils._.underscoredIf('updatedAt', this.options.underscored)] = {type: DataTypes.DATE, allowNull: false}

      if(this.options.paranoid)
        defaultAttributes[Utils._.underscoredIf('deletedAt', this.options.underscored)] = {type: DataTypes.DATE}
    }

    Utils._.each(defaultAttributes, function(value, attr) {
      self.rawAttributes[attr] = value
    })
  }

  var findAutoIncrementField = function() {
    var fields = this.QueryGenerator.findAutoIncrementField(this)

    this.autoIncrementField = null

    fields.forEach(function(field) {
      if (this.autoIncrementField) {
        throw new Error('Invalid DAO definition. Only one autoincrement field allowed.')
      } else {
        this.autoIncrementField = field
      }
    }.bind(this))
  }

  Utils._.extend(DAOFactory.prototype, require("./associations/mixin"))

  return DAOFactory
})()
