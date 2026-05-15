/**
 * The object file for the scheduler so that the scheduler can
 * receive information from the session manager.
 */

export class DOFetcherAdapter implements Fetcher {
  constructor(
    private readonly ns: DurableObjectNamespace,
    private readonly name: string
  ) {}

  fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const stub = this.ns.get(this.ns.idFromName(this.name));
    return stub.fetch(input, init);
  }

  connect(_address: string | SocketAddress, _options?: SocketOptions): Socket {
    throw new Error("DOFetcherAdapter does not support connect()");
  }
}
