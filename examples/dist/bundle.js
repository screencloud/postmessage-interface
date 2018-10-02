(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
(function (global){
var Interface = require('./libs/interface.js')

if (global.window) {
  global.window.PostMessageInterface = Interface
}

module.exports = Interface

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./libs/interface.js":2}],2:[function(require,module,exports){

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
  var message = this._codec.decode(e.data)
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

},{"events":3}],3:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      } else {
        // At least give some kind of context to the user
        var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
        err.context = er;
        throw err;
      }
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}]},{},[1]);
