import http from '@ohos.net.http';

type HeaderMap = Record<string, string>;

type RequestBody = Record<string, string | number | string[] | object[]>;

@Entry
@Component
struct Index {
  @State apiBase: string = 'https://api.example/v1';
  @State nodeId: string = '';
  @State nodeToken: string = '';
  @State output: string = 'Enter API Base, Node ID and Node Token, then run a smoke request.';

  private headers(): HeaderMap {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.nodeToken}`,
      'X-Node-Id': this.nodeId,
    };
  }

  private endpoint(path: string): string {
    const trimmed = this.apiBase.endsWith('/') ? this.apiBase.substring(0, this.apiBase.length - 1) : this.apiBase;
    return `${trimmed}${path}`;
  }

  private async request(method: http.RequestMethod, path: string, body?: RequestBody): Promise<void> {
    const client = http.createHttp();
    try {
      const response = await client.request(this.endpoint(path), {
        method,
        header: this.headers(),
        extraData: body === undefined ? undefined : JSON.stringify(body),
        connectTimeout: 10000,
        readTimeout: 10000,
      });
      this.output = `HTTP ${response.responseCode}\n${String(response.result)}`;
    } catch (error) {
      this.output = `ERROR\n${JSON.stringify(error)}`;
    } finally {
      client.destroy();
    }
  }

  build() {
    Scroll() {
      Column({ space: 12 }) {
        Text('Xpod Reachability Smoke')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)

        TextInput({ placeholder: 'https://api.example/v1', text: this.apiBase })
          .onChange((value: string) => { this.apiBase = value; })

        TextInput({ placeholder: 'node id', text: this.nodeId })
          .onChange((value: string) => { this.nodeId = value; })

        TextInput({ placeholder: 'node token', text: this.nodeToken })
          .type(InputType.Password)
          .onChange((value: string) => { this.nodeToken = value; })

        Button('GET routes')
          .width('100%')
          .onClick(() => {
            void this.request(http.RequestMethod.GET, `/nodes/${this.nodeId}/routes`);
          })

        Button('POST p2p session')
          .width('100%')
          .onClick(() => {
            void this.request(http.RequestMethod.POST, `/nodes/${this.nodeId}/p2p-sessions`, {
              clientId: 'harmony-smoke',
              capabilities: ['tcp-punch'],
              candidates: [],
            });
          })

        Button('POST relay session')
          .width('100%')
          .onClick(() => {
            void this.request(http.RequestMethod.POST, `/nodes/${this.nodeId}/relay-sessions`, {
              reason: 'harmony smoke verification',
              ttlSeconds: 300,
              bandwidthLimitBytes: 1048576,
            });
          })

        Text(this.output)
          .fontSize(13)
          .width('100%')
          .padding(12)
          .backgroundColor('#F4F6F8')
      }
      .padding(16)
      .width('100%')
    }
  }
}
