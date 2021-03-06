// tslint:disable:no-any
import { Message, MessageType, ByteArray, Package, PackageType, strencode, strdecode } from '@regax/protocol'
import { EventEmitter, PlainData, values, RegaxError } from '@regax/common'
import { RegaxWebSocket, WebSocketClass, HandshakeBuffer, SocketEvent, DEFAULT_MAX_RECONNECT_ATTEMPTS } from './socket'

const JS_WS_CLIENT_TYPE = 'js-websocket'
const JS_WS_CLIENT_VERSION = '0.0.1'
const socketEvents = values(SocketEvent)

export interface RSA {
  generate(num: number, type: string): void,
  signString(str: string, type: string): any
  n: any,
  e: any
}

export interface ClientOpts {
  url?: string,
  encrypt?: boolean,
  rsa?: RSA, // RSA encrypt
  user?: PlainData,
  reconnect?: boolean, // 是否重连，默认false
  maxReconnectAttempts?: number, // 最大连接数, 默认10
  WebSocket?: WebSocketClass
}

export interface Response {
  code?: number | string, // code
  message?: string, // error message
  data?: PlainData
}

export type Route = number | string

export class Client extends EventEmitter<string> {
  protected reqId = 0
  protected callbacks: { [key: string]: { res: (d?: PlainData) => void, rej: (e: Error) => void} } = {} // request callbacks
  protected routeMap: { [key: string]: string | number} = {} // Map from request id to route
  protected dict: { [key: string]: string | number } = {}    // route string to code
  protected socket = new RegaxWebSocket()
  protected handshakeBuffer: HandshakeBuffer = {
    'sys': {
      type: JS_WS_CLIENT_TYPE,
      version: JS_WS_CLIENT_VERSION,
      rsa: {}
    },
    'user': {
    }
  }
  protected useCrypto: boolean = false // 是否加密
  protected rsa: RSA
  protected opts: ClientOpts = {}
  constructor(
    opts?: ClientOpts,
  ) {
    super()
    if (opts) this.config(opts)
    this.socket.on(SocketEvent.DATA, this.onMessage.bind(this))
    socketEvents.forEach((k: SocketEvent) => this.socket.on(k, (data: any) => this.emit(k, data)))
  }
  protected decode(data: ByteArray): any {
    const msg = Message.decode(data)
    if (msg.id > 0) {
      msg.route = this.routeMap[msg.id]
      delete this.routeMap[msg.id]
      if (!msg.route) {
        return
      }
    }
    // TODO compress route
    msg.body = JSON.parse(strdecode(msg.body))
    return msg
  }
  protected encode(id: number, route: string | number, data: any): ByteArray {
    const type = id ? MessageType.REQUEST : MessageType.NOTIFY

    const msg = strencode(JSON.stringify(data))

    let compressRoute = 0
    if (this.dict && this.dict[route]) {
      route = this.dict[route]
      compressRoute = 1
    }

    return Message.encode(id, type, compressRoute, route, msg)
  }
  protected sendMessage(id: number, route: Route, data: any): void {
    if (this.useCrypto && this.rsa) {
      const cache = JSON.stringify(data)
      const sig = this.rsa.signString(cache, 'sha256')
      data = JSON.parse(cache)
      data['__crypto__'] = sig
    }
    const msg = this.encode(id, route, data)
    const packet = Package.encode(PackageType.DATA, msg)
    this.socket.send(packet)
  }
  protected onMessage(data: ByteArray): void {
    const msg = this.decode(data)
    if (!msg) return
    if (!msg.id) {
      // server push message
      this.emit(msg.route, msg.body)
      return
    }
    // if have a id then find the callback function with the request
    const cb = this.callbacks[msg.id]

    if (cb) {
      delete this.callbacks[msg.id]
      const resp: Response = msg.body || {}
      if (resp.code && resp.code !== 200) {
        this.emit('error', RegaxError.create(resp.message!, resp.code))
        cb.rej(RegaxError.create(resp.message || 'Server Error', resp.code))
      } else {
        cb.res(resp.data)
      }
    }
  }

  async connect(opts?: ClientOpts): Promise<HandshakeBuffer> {
    if (opts) this.config(opts)
    const { url, encrypt, reconnect, maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS, WebSocket: WS } = this.opts
    if (encrypt && this.rsa) {
      this.useCrypto = true
      this.rsa.generate(1024, '10001')
      this.handshakeBuffer.sys.rsa = {
        rsa_n: this.rsa.n.toString(16),
        rsa_e: this.rsa.e
      }
    }
    let reconnectAttempts = 0
    return new Promise((res, rej) => {
      this.socket.connect(url!, { reconnect, maxReconnectAttempts, handshakeBuffer: this.handshakeBuffer, WebSocket: WS })
      const reject = () => {
        if (reconnect && reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts ++
          return
        }
        this.off(SocketEvent.CONNECTION, response)
        rej(RegaxError.create('[regax-websocket] Connection refused'))
      }
      const response = () => {
        this.off(SocketEvent.DISCONNECT, reject)
        res()
      }
      this.socket.once(SocketEvent.CONNECTION, response)
      this.socket.once(SocketEvent.DISCONNECT, reject)
    })
  }
  disconnect(): void {
    this.socket.close()
  }
  async request(route: Route, msg = {}): Promise<any> {
    return new Promise<any>((res, rej) => {
      if (!route) {
        return
      }
      this.reqId++
      this.callbacks[this.reqId] = { res, rej }
      this.routeMap[this.reqId] = route
      this.sendMessage(this.reqId, route, msg)
    })
  }
  notify(route: Route, msg = {}): void {
    this.sendMessage(0, route, msg)
  }
  config(opts: ClientOpts): void {
    Object.assign(this.opts, opts)
    if (opts.user) this.handshakeBuffer.user = opts.user
    if (opts.rsa) this.rsa = opts.rsa
  }
}
