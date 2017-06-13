const Interface = require('../libs/interface.js')

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
      output.receive({
        data: data,
        origin: origin,
        source: interfaces.input
      })
    }
  }
  interfaces.input = {
    postMessage: (data, origin) => {
      input.receive({
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
    const op = new Interface()
    expect(op.id).not.toBe(undefined)
  })
  it('should be able to expose and call methods', function () {
    const a = new Interface({id: 'A', api: testAPI})
    const b = new Interface({id: 'B', timeout: 500})
    return b.connect(mockWindowInterface(b, a)).then((api) => {
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
    const a = new Interface({id: 'A', api: testAPI, guard: () => true })
    const b = new Interface({timeout: 500})
    return b.connect(mockWindowInterface(b, a)).then((api) => {
      return Promise.resolve().then(() => {
        api.fire('foo', 'bar')
        delayedResolve(10)
      }).then(() => {
        expect(a.api.events.length).toBe(1)
      })
    })
  })
  it('should timeout if not connected', function () {
    const a = new Interface({id: 'A', connectTimeout: 100})
    return a.connect(mockWindowInterface(a, {
      receive: () => {}
    })).catch((err) => {
      expect(err.toString().indexOf('connect timeout') !== -1).toBe(true)
    })
  })
  it('should be possible to add an input guard', function () {
    const state = {}
    const a = new Interface({
      id: 'A',
      connectTimeout: 100,
      api: {echo: (v) => v},
      // only allow from b
      guard: (e) => e.source === state.bInterface
    })
    const b = new Interface({id: 'B', api: {
    }, timeout: 500, connectTimeout: 100})
    const c = new Interface({id: 'C', api: {
    }, timeout: 500, connectTimeout: 100})
    state.bInterface = mockWindowInterface(b, a)
    return b.connect(state.bInterface).then((api) => {
      return c.connect(mockWindowInterface(c, a))
    }).catch((err) => {
      expect(err.toString().indexOf('connect timeout') !== -1).toBe(true)
    })
  })
})
