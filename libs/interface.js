
var now = () => (new Date()).getTime()

function Interface (opts) {
  opts = opts || {}
  this.opts = opts
  if (this.opts.window === undefined) {
    this.opts.window = window
  }
  this.codec = opts.codec || {
    encode: JSON.stringify,
    decode: JSON.parse
  }
  if (this.opts.window) {
    this.setWindow(this.opts.window, this.opts.guard)
  }
  this.api = opts.api
  this.timeout = opts.timeout || 5000
  this.pingInterval = opts.pingInterval || 100
  this.connectTimeout = opts.connectTimeout || 10000
  // this.setOutputOnFirstPing = opts.setOutputOnFirstPing
  this.id = opts.id || ('pmi_' + now())
  // this.connected = false
  this._calls = 0
  this._pendingCalls = {}
  this._pendingConnections = {}
}

Interface.prototype.connect = function (output, origin) {
  return new Promise((resolve, reject) => {
    var id = 'connection_' + now()
    var pendingConnection = {}
    this._pendingConnections[id] = pendingConnection
    var cleanup = () => {
      clearInterval(pendingConnection.pingIntervalRef)
      clearTimeout(pendingConnection.timeoutRef)
      delete this._pendingConnections[id]
    }
    pendingConnection.timeoutRef = setTimeout(() => {
      reject(new Error('connect timeout'))
      cleanup()
    }, this.connectTimeout)
    pendingConnection.connected = () => {
      resolve({
        call: (method, args, timeout) => this._call(method, args, timeout, output, origin),
        fire: (name, data) => this._fire(name, data, output, origin)
      })
      cleanup()
    }
    pendingConnection.pingIntervalRef = setInterval(() => this._ping(id, output, origin), this.pingInterval)
    this._ping(id, output, origin)
  })
}

Interface.prototype.setWindow = function (window, guard) {
  if (guard) { this.guard = guard }
  this.window = window
  this.window.addEventListener('message', this.receive.bind(this))
}

Interface.prototype.receive = function (e) {
  if (this.guard) {
    if (!this.guard(e)) {
      return
    }
  }
  var message = this.codec.decode(e.data)
  if (message.ping) {
    this._handlePing(message.ping, e)
  } else if (message.pong) {
    this._handlePong(message.pong)
  } else if (message.result) {
    this._handleResult(message.result)
  } else if (message.call) {
    this._handleCall(message.call, e)
  } else if (message.event) {
    this._handleEvent(message.event)
  }
}

// -----------------------------------------------------------------------------

Interface.prototype._ping = function (connection, output, origin) {
  this._send({
    ping: {
      from: this.id,
      connection: connection
    }
  }, output, origin)
}

Interface.prototype._fire = function (type, data, output, origin) {
  // sends event, no response
  this._send({
    event: {
      type: type,
      data: data
    }
  }, output, origin)
}

Interface.prototype._call = function (method, args, timeout, output, origin) {
  var id = this._calls++
  // returns promise
  // rejects after timeout if not response
  timeout = timeout || this.timeout
  return new Promise((resolve, reject) => {
    this._pendingCalls[id] = {
      resolve: resolve,
      reject: reject,
      ts: now(),
      timeout: timeout,
      timeoutRef: setTimeout(() => {
        this._timeout(id)
      }, timeout)
    }
    this._send({
      call: {
        id: id,
        method: method,
        args: args
      }
    }, output, origin)
  })
}

Interface.prototype._timeout = function (id) {
  var err = new Error('call timeout')
  err.info = {id: id}
  this._reject(id, err)
}

Interface.prototype._resolve = function (id, value) {
  var call = this._pendingCalls[id]
  if (call) {
    clearTimeout(call.timeoutRef)
    call.resolve(value)
    delete this._pendingCalls[id]
  }
}

Interface.prototype._reject = function (id, error) {
  var call = this._pendingCalls[id]
  if (call) {
    clearTimeout(call.timeoutRef)
    call.reject(error)
    delete this._pendingCalls[id]
  }
}

Interface.prototype._handlePing = function (ping, e) {
  this._reply({
    pong: {
      to: ping.from,
      from: ping.source,
      connection: ping.connection
    }
  }, e)
}

Interface.prototype._handlePong = function (pong) {
  if (pong.to !== this.id) {
    throw new Error('pong to address does not match self')
  }
  var pendingConnection = this._pendingConnections[pong.connection]
  if (pendingConnection) {
    pendingConnection.connected()
  }
}

Interface.prototype._handleResult = function (result) {
  if (result.value) {
    this._resolve(result.id, result.value)
  } else if (result.error) {
    this._reject(result.id, new Error(result.error))
  }
}

Interface.prototype._handleCall = function (call, e) {
  try {
    var result = this.api[call.method].apply(this.api, call.args)
    // check if its a promise or just a value
    if (result !== undefined && result.then) {
      result.then((value) => {
        this._reply({
          result: {
            id: call.id,
            value: value
          }
        }, e)
      }).catch((err) => {
        this._reply({
          result: {
            id: call.id,
            error: err.toString()
          }
        }, e)
      })
    } else {
      // result isnt a promise
      this._reply({
        result: {
          id: call.id,
          value: result
        }
      }, e)
    }
  } catch (err) {
    this._reply({
      result: {
        id: call.id,
        error: err.toString()
      }
    }, e)
  }
}

Interface.prototype._handleEvent = function (event) {
  if (this.api && this.api.emit) {
    this.api.emit(event.type, event.data)
  }
}

Interface.prototype._reply = function (obj, e) {
  var data = this.codec.encode(obj)
  // console.log('_reply', e, data)
  e.source.postMessage(data, e.origin || '*')
}

Interface.prototype._send = function (obj, output, origin) {
  if (output) {
    var data = this.codec.encode(obj)
    origin = origin || '*'
    // console.log('postMessage', data, output, origin)
    output.postMessage(data, origin)
    return
  }
}

module.exports = Interface
