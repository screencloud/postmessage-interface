
const EventEmitter = require('events').EventEmitter

const now = function () { return (new Date()).getTime() }

const DEFAULT_CODEC = {
  encode: JSON.stringify,
  decode: JSON.parse
}

// -----------------------------------------------------------------------------

function ExposedInterface (handler, opts) {
  this._handler = handler
  opts = opts || {}
  this.id = opts.id || ('ExposedInterface_' + now())
  this._codec = opts.codec || DEFAULT_CODEC
  this._window = opts.window || window
  this._guard = opts.guard
  this._receiveHandler = this._receive.bind(this)
  this._window.addEventListener('message', this._receiveHandler)
  this._subscribedListeners = {}
}

ExposedInterface.prototype.dispose = function () {
  this._window.removeEventListener('message', this._receiveHandler)
  this._subscribedListeners = {}
}

ExposedInterface.prototype._receive = function (e) {
  if (this._guard) {
    if (!this._guard(e)) {
      return
    }
  }
  var message = e.data.indexOf('{') === 0 && this._codec.decode(e.data)
  if (!message) {
    return
  } else if (message.ping) {
    this._handlePing(message.ping, e)
  } else if (message.call) {
    this._handleCall(message.call, e)
  } else if (message.subscribe) {
    this._handleSubscribe(message.subscribe, e)
  } else if (message.unsubscribe) {
    this._handleUnsubscribe(message.unsubscribe, e)
  } else if (message.event) {
    this._handleEvent(message.event)
  }
}

ExposedInterface.prototype._handlePing = function (ping, e) {
  this._reply({
    pong: {
      to: ping.from,
      from: ping.source,
      connection: ping.connection
    }
  }, e)
}

ExposedInterface.prototype._handleCall = function (call, e) {
  var self = this
  try {
    if (!this._handler || this._handler[call.method] === undefined) {
      throw new Error('missing api method: ' + call.method)
    }
    var result = this._handler[call.method].apply(this._handler, call.args)
    // check if its a promise or just a value
    if (result !== undefined && result.then) {
      result.then(function (value) {
        self._reply({
          result: {
            id: call.id,
            value: value
          }
        }, e)
      }).catch(function (err) {
        console.log('call resulted in error', err)
        self._reply({
          result: {
            id: call.id,
            error: err.toString()
          }
        }, e)
      })
    } else {
      // result isnt a promise
      self._reply({
        result: {
          id: call.id,
          value: result
        }
      }, e)
    }
  } catch (err) {
    console.log('call resulted in error', err)
    self._reply({
      result: {
        id: call.id,
        error: err.toString()
      }
    }, e)
  }
}

ExposedInterface.prototype._handleSubscribe = function (eventName, e) {
  if (this._handler && this._handler.addListener) {
    const listener = function (data) {
      this._reply({
        event: {
          type: eventName,
          data: data
        }
      }, e)
    }.bind(this)
    this._subscribedListeners[listener] = {
      source: e.source,
      origin: e.orgin,
      eventName: eventName
    }
    this._handler.addListener(eventName, listener)
  }
}

ExposedInterface.prototype._handleUnsubscribe = function (eventName, e) {
  const listeners = Object.keys(this._subscribedListeners)
  var listener
  var sub
  for (var i = 0; i < listeners.length; i++) {
    listener = listeners[i]
    sub = this._subscribedListeners[listener]
    if (sub.eventName === eventName && sub.source === e.source && sub.origin === e.origin) {
      // its a match..
      this._handler.removeListener(eventName, listener)
      delete this._subscribedListeners[listener]
      return
    }
  }
}

ExposedInterface.prototype._handleEvent = function (event) {
  if (this._handler && this._handler.emit) {
    this._handler.emit(event.type, event.data)
  }
}

ExposedInterface.prototype._reply = function (obj, e) {
  var data = this._codec.encode(obj)
  e.source.postMessage(data, e.origin || '*')
}

// -----------------------------------------------------------------------------

function RemoteInterface (opts) {
  opts = opts || {}
  this.id = opts.id || ('RemoteInterface_' + now())
  this._codec = opts.codec || DEFAULT_CODEC
  this._origin = opts.origin || '*'
  this._window = opts.window || window
  this._guard = opts.guard
  // extra stuff for remote interfaces
  this._timeout = opts.timeout || 5000
  this._pingInterval = opts.pingInterval || 100
  this._connectTimeout = opts.connectTimeout || 10000
  this._calls = 0
  this._pendingCalls = {}
  this._connected = false
  this._pendingConnections = {}
  this._eventEmitter = new EventEmitter()
}

RemoteInterface.prototype.dispose = function () {
  this._window.removeEventListener('message', this._receiveHandler)
  this._connected = false
}

RemoteInterface.prototype.connect = function (output) {
  this._output = output
  this._receiveHandler = this._receive.bind(this)
  this._window.addEventListener('message', this._receiveHandler)
  // REVIEW: extra code for multiple pending connections is no longer needed
  var self = this
  return new Promise(function (resolve, reject) {
    var connId = self.id + '_conn_' + now()
    var pendingConnection = {}
    self._pendingConnections[connId] = pendingConnection
    var cleanup = function () {
      clearInterval(pendingConnection.pingIntervalRef)
      clearTimeout(pendingConnection.timeoutRef)
      delete self._pendingConnections[connId]
    }
    pendingConnection.timeoutRef = setTimeout(function () {
      self.dispose()
      cleanup()
      reject(new Error('connect timeout'))
    }, self._connectTimeout)
    pendingConnection.connected = function () {
      cleanup()
      resolve(self)
    }
    pendingConnection.pingIntervalRef = setInterval(function () {
      return self._ping(connId)
    }, self._pingInterval)
    self._ping(connId)
  })
}

RemoteInterface.prototype.call = function (method, args, timeout) {
  // returns promise, rejects after timeout if no response
  var id = this._calls++
  timeout = timeout || this._timeout
  // console.log('got timeout', timeout)
  var self = this
  return new Promise(function (resolve, reject) {
    self._pendingCalls[id] = {
      resolve: resolve,
      reject: reject,
      ts: now(),
      timeout: timeout,
      timeoutRef: setTimeout(function () {
        // console.log('timeout!', id)
        var err = new Error('call timeout: ' + method)
        err.info = {id: id}
        self._reject(id, err)
      }, timeout)
    }
    self._send({
      call: {
        id: id,
        method: method,
        args: args
      }
    })
  })
}

RemoteInterface.prototype.fire = function (type, data) {
  // sends event, no response
  this._send({
    event: {
      type: type,
      data: data
    }
  })
}

RemoteInterface.prototype.addListener = function (eventName, listener) {
  const count = this._eventEmitter.listenerCount('eventName')
  this._eventEmitter.addListener(eventName, listener)
  if (count === 0) {
    // go ahead and register it..
    this._send({subscribe: eventName})
  }
}

RemoteInterface.prototype.removeListener = function (eventName, listener) {
  this._eventEmitter.removeListener(eventName, listener)
  const count = this._eventEmitter.listenerCount('eventName')
  if (count === 0) {
    // go ahead and register it..
    this._send({unsubscribe: eventName})
  }
}

RemoteInterface.prototype.on = function (eventName, listener) {
  return this.addListener(eventName, listener)
}

RemoteInterface.prototype.off = function (eventName, listener) {
  return this.removeListener(eventName, listener)
}

RemoteInterface.prototype._receive = function (e) {
  if (this._guard) {
    if (!this._guard(e)) {
      return
    }
  }
  try {
      var message = this._codec.decode(e.data)
  } catch (err) {
    console.log('Warning: could not decode a message', err.message, 'Data:', e.data)
    return
  }

  if (message.pong) {
    this._handlePong(message.pong)
  } else if (message.result) {
    this._handleResult(message.result)
  } else if (message.event) {
    this._handleEvent(message.event)
  }
}

RemoteInterface.prototype._ping = function (connection) {
  this._send({
    ping: {
      from: this.id,
      connection: connection
    }
  })
}

RemoteInterface.prototype._resolve = function (id, value) {
  var call = this._pendingCalls[id]
  if (call) {
    clearTimeout(call.timeoutRef)
    call.resolve(value)
    delete this._pendingCalls[id]
  }
}

RemoteInterface.prototype._reject = function (id, error) {
  console.log('reject!!!', id, error)
  var call = this._pendingCalls[id]
  if (call) {
    clearTimeout(call.timeoutRef)
    call.reject(error)
    delete this._pendingCalls[id]
  }
}

RemoteInterface.prototype._handlePong = function (pong) {
  if (pong.to !== this.id) {
    throw new Error('pong to address does not match self')
  }
  var pendingConnection = this._pendingConnections[pong.connection]
  if (pendingConnection) {
    pendingConnection.connected()
  }
}

RemoteInterface.prototype._handleResult = function (result) {
  if (result.error) {
    this._reject(result.id, new Error(result.error))
  } else {
    this._resolve(result.id, result.value)
  }
}

RemoteInterface.prototype._handleEvent = function (event) {
  console.log(event)
  this._eventEmitter.emit(event.type, event.data)
}

RemoteInterface.prototype._send = function (obj) {
  if (this._output) {
    var data = this._codec.encode(obj)
    this._output.postMessage(data, this._origin)
    return
  }
}

// -----------------------------------------------------------------------------

module.exports = {
  ExposedInterface: ExposedInterface,
  RemoteInterface: RemoteInterface
}
