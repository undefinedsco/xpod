interface DnsChallengeClientOptions {
  signalEndpoint: string;
  nodeId: string;
  nodeToken: string;
}

type ChallengeAction = 'set' | 'remove';

export class DnsChallengeClient {
  private readonly endpoint: string;
  private readonly nodeId: string;
  private readonly nodeToken: string;

  public constructor(options: DnsChallengeClientOptions) {
    this.endpoint = options.signalEndpoint.replace(/\/$/, '');
    this.nodeId = options.nodeId;
    this.nodeToken = options.nodeToken;
  }

  public async setChallenge(host: string, value: string): Promise<void> {
    await this.postChallenge('set', host, value);
  }

  public async removeChallenge(host: string, value?: string): Promise<void> {
    await this.postChallenge('remove', host, value);
  }

  private async postChallenge(action: ChallengeAction, host: string, value?: string): Promise<void> {
    const body = {
      nodeId: this.nodeId,
      token: this.nodeToken,
      metadata: {
        certificate: {
          dns01: {
            action,
            host,
            value,
          },
        },
      },
    };

    await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }
}
