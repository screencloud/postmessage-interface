const PMI = require('../libs/interface.js')
const ExposedInterface = PMI.ExposedInterface
const RemoteInterface = PMI.RemoteInterface
const EventEmitter = require('events').EventEmitter
const util = require('util')

const delayedResolve = (delay, value) => {
  return new Promise((resolve, reject) => {
    setTimeout(() => resolve(value), delay)
  })
}

const testAPI = {
  add: function (a, b) {
    return a + b
  },
  echo: function (val) {
    return val
  },
  delayEcho: function (delay, value) {
    return new Promise((resolve, reject) => {
      setTimeout(() => resolve(value), delay)
    })
  },
  errorPromise: function (message) {
    return new Promise((resolve, reject) => {
      reject(new Error(message))
    })
  },
  neverReturnPromise: function (message) {
    return new Promise((resolve, reject) => {
      //
    })
  },
  someError: function () {
    throw new Error('fooo')
  },
  nothingReturned: function () {
    console.log('called nothing')
  },
  emit: function (name, data) {
    this.events = this.events || []
    this.events.push({name: name, data: data})
  }
}

function mockWindowInterface (input, output) {
  const interfaces = {}
  interfaces.output = {
    postMessage: (data, origin) => {
      console.log('input.postMessage', data, origin)
      output._receive({
        data: data,
        origin: origin,
        source: interfaces.input
      })
    }
  }
  interfaces.input = {
    postMessage: (data, origin) => {
      console.log('output.postMessage', data, origin)
      input._receive({
        data: data,
        origin: origin,
        source: interfaces.output
      })
    }
  }
  return interfaces.output
}

describe('postmessage interface', function () {
  it('should not require any options', function () {
    const op = new RemoteInterface()
    expect(op.id).not.toBe(undefined)
  })
  it('should be able to expose and call methods', function () {
    const exposed = new ExposedInterface(testAPI, {id: 'Exposed'})
    const remote = new RemoteInterface({id: 'Remote', timeout: 500})
    const mockWindow = new mockWindowInterface(remote, exposed)
    return remote.connect(mockWindow).then((api) => {
      return Promise.resolve().then(() => {
        return api.call('add', [10, 5]).then((result) => {
          expect(result).toBe(15)
        })
      }).then(() => {
        return api.call('echo', ['foo']).then((value) => {
          expect(value).toBe('foo')
        })
      }).then(() => {
        return api.call('delayEcho', [100, 'fooo']).then((value) => {
          expect(value).toBe('fooo')
        })
      }).then(() => {
        return api.call('errorPromise', ['hahah']).catch((err) => {
          expect(err.toString().indexOf('hahah') !== -1).toBe(true)
        })
      }).then(() => {
        return api.call('someError', []).catch((err) => {
          expect(err.toString().indexOf('fooo') !== -1).toBe(true)
        })
      }).then(() => {
        return api.call('neverReturnPromise', []).catch((err) => {
          expect(err.toString().indexOf('timeout') !== -1).toBe(true)
        })
      })
    })
  })
  it('should be able to send and receive events', function () {
    const exposed = new ExposedInterface(testAPI, {id: 'Exposed', guard: () => true })
    const remote = new RemoteInterface({timeout: 500})
    const mockWindow = mockWindowInterface(remote, exposed)
    return remote.connect(mockWindow).then((api) => {
      return Promise.resolve().then(() => {
        api.fire('foo', 'bar')
        delayedResolve(10)
      }).then(() => {
        expect(exposed._handler.events.length).toBe(1)
      })
    })
  })
  it('should timeout if not connected', function () {
    const remote = new RemoteInterface({id: 'Remote', connectTimeout: 100})
    const mockWindow = mockWindowInterface(remote, {_receive: () => {}})
    return remote.connect(mockWindow).catch((err) => {
      expect(err.toString().indexOf('connect timeout') !== -1).toBe(true)
    })
  })
  it('should be possible to add an input guard', function () {
    const state = {}
    const exposed = new ExposedInterface(
      {echo: (v) => v},
      {
        id: 'Exposed',
        connectTimeout: 100,
      // only allow from 1
        guard: (e) => e.source === state.mockWindow1
      })
    const remote1 = new RemoteInterface({id: 'Remote1', timeout: 500, connectTimeout: 100})
    const remote2 = new RemoteInterface({id: 'Remote2', timeout: 500, connectTimeout: 100})
    const mockWindow1 = mockWindowInterface(remote1, exposed)
    state.mockWindow1 = mockWindow1
    const mockWindow2 = mockWindowInterface(remote2, exposed)
    return remote1.connect(mockWindow1).then((api) => {
      return remote2.connect(mockWindow2)
    }).catch((err) => {
      expect(err.toString().indexOf('connect timeout') !== -1).toBe(true)
    })
  })

  it('should be possible to add an input guard', function () {
    const state = {}

    const EventEmitterHandler = function () {

    }

    util.inherits(EventEmitterHandler, EventEmitter)

    EventEmitterHandler.prototype.echo = (v) => v
    const eventEmitterHandler = new EventEmitterHandler()

    const exposed = new ExposedInterface(
      eventEmitterHandler,
      {
        id: 'eventEmitterHandler',
        connectTimeout: 100
      })
    const remote = new RemoteInterface({id: 'Remote1', timeout: 500, connectTimeout: 100})
    const mockWindow = mockWindowInterface(remote, exposed)
    return remote.connect(mockWindow).then((api) => {
      return new Promise((resolve, reject) => {
        api.on('foo', (data) => {
          console.log(data)
          expect(data).toBe('bar')
          resolve()
        })
        eventEmitterHandler.emit('foo', 'bar')
      })
    })
  })
})
