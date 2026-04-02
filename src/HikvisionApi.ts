import https from 'https';
import DigestFetch from 'digest-fetch';
import { XMLParser } from 'fast-xml-parser';
import { PlatformConfig } from 'homebridge';
import { MultipartXmlStreamParser } from './lib/MultiPartXMLStreamParser.js';
import { createLoggedDigestFetch } from './lib/loggedDigestFetch.js';

export interface HikVisionNvrApiConfiguration extends PlatformConfig {
  host: string
  port: number
  secure: boolean
  ignoreInsecureTls: boolean
  username: string
  password: string
  debugFfmpeg: boolean
  doorbells: string[]
  debug: boolean
  useSubStream: boolean
}

export class HikvisionApi {
  private xmlParser: XMLParser;
  private log?: any;
  private config: HikVisionNvrApiConfiguration;
  public _baseURL?: string;
  public connected: boolean = false;
  private client: DigestFetch;
  private abortController: AbortController | null = null;
  private isStreaming: boolean = false;

  constructor(config: HikVisionNvrApiConfiguration, log: any) {
    this._baseURL = `http${config.secure ? 's' : ''}://${config.host}`;
    this.config = config;
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
    });
    this.log = log;

    this.client = createLoggedDigestFetch(
      this.config.username,
      this.config.password,
      {
        algorithm: 'MD5',
        timeout: 8000,
        agent: new https.Agent({ rejectUnauthorized: !this.config.ignoreInsecureTls }),
      },
      (msg: string) => this.log.debug(msg),
    );
  }

  public async getSystemInfo() {
    return this._getResponse('/ISAPI/System/deviceInfo');
  }

  async getCameras() {
    const channels = await this._getResponse('/ISAPI/System/Video/inputs/channels');

    if (channels.VideoInputChannelList) {
      for (let i = 0; i < channels.VideoInputChannelList.VideoInputChannel.length; i++) {
        const channel = channels.VideoInputChannelList.VideoInputChannel[i];
        if (channel.resDesc !== 'NO VIDEO') {
          channel.capabilities = await this._getCapabilities(channel.id);
        }
        channel.status = { online: channel.resDesc !== 'NO VIDEO' };
      }

      return channels.VideoInputChannelList.VideoInputChannel.filter((camera: { status: { online: boolean; }; }) => camera.status.online);
    } else {
      const channels2 = await this._getResponse('/ISAPI/ContentMgmt/InputProxy/channels');

      for (let i = 0; i < channels2.InputProxyChannelList.InputProxyChannel.length; i++) {
        const channel = channels2.InputProxyChannelList.InputProxyChannel[i];
        if (channel.resDesc !== 'NO VIDEO') {
          channel.capabilities = await this._getCapabilities(channel.id);
        }
        channel.status = { online: channel.resDesc !== 'NO VIDEO' };
      }

      return channels2.InputProxyChannelList.InputProxyChannel.filter((camera: { status: { online: boolean; }; }) => camera.status.online);
    }
  }

  // Try StreamingProxy first (NVR), fall back to direct Streaming endpoint (older/hybrid DVR)
  private async _getCapabilities(channelId: string): Promise<any> {
    const proxyPath = `/ISAPI/ContentMgmt/StreamingProxy/channels/${channelId}01/capabilities`;
    const directPath = `/ISAPI/Streaming/channels/${channelId}01/capabilities`;

    const proxyResult = await this._getResponse(proxyPath);

    if (proxyResult?.StreamingChannel) {
      this.log.debug(`Capabilities for channel ${channelId} via StreamingProxy`);
      return proxyResult;
    }

    this.log.debug(`StreamingProxy capabilities not available for channel ${channelId} (403 or missing StreamingChannel), trying direct Streaming endpoint...`);
    const directResult = await this._getResponse(directPath);

    if (directResult?.StreamingChannel) {
      this.log.debug(`Capabilities for channel ${channelId} via direct Streaming endpoint`);
      return directResult;
    }

    // Last resort: synthesise minimal capabilities from the channel info itself
    // so the camera still registers even if neither endpoint works.
    this.log.warn(`Could not retrieve capabilities for channel ${channelId} from any endpoint. Using fallback defaults.`);
    return {
      StreamingChannel: {
        Video: {
          videoResolutionWidth: { '#text': 1280 },
          videoResolutionHeight: { '#text': 720 },
          maxFrameRate: { '#text': 2500 }, // 25fps * 100
          vbrUpperCap: { '#text': 2048 },
        },
        Audio: null,
      },
    };
  }

  async startMonitoringEvents(callback: (event: any) => void): Promise<void> {
    const url = `${this._baseURL}/ISAPI/Event/notification/alertStream`;
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

    const startStream = async () => {
      if (this.isStreaming) {
        this.log.debug('Stream already active, skipping new connection');
        return;
      }

      this.isStreaming = true;
      this.abortController = new AbortController();

      try {
        const res = await this.client.fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'multipart/mixed',
          },
          signal: this.abortController.signal,
        });

        if (res.status === 403) {
          this.log.warn('Received 403 — likely expired digest nonce. Reconnecting...');
          this.isStreaming = false;
          setTimeout(startStream, 5000);
          return;
        }

        if (!res.ok || !res.body) {
          this.log.error(`Stream connection failed: ${res.status} -> ${res.statusText}`);
          this.isStreaming = false;
          setTimeout(startStream, 30000);
          return;
        }

        const streamParser = new MultipartXmlStreamParser();

        streamParser.on('message', (part) => {
          try {
            const event = parser.parse(part.body);
            callback(event);
          } catch (e) {
            this.log.error(`Failed to parse XML: ${e instanceof Error ? e.message : String(e)}`);
            this.log.debug(`Fragment: ${part.body}`);
          }
        });

        streamParser.on('error', (err) => {
          this.log.error(`Stream parse error: ${err}`);
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        const pump = async (): Promise<void> => {
          try {
            const { value, done } = await reader.read();
            if (done) {
              this.log.warn('Stream ended. Reconnecting...');
              this.isStreaming = false;
              setTimeout(startStream, 30000);
              return;
            }

            streamParser.write(decoder.decode(value, { stream: true }));
            await pump();
          } catch (err: any) {
            this.log.error(`Stream read error: ${err.message}`);
            this.isStreaming = false;
            setTimeout(startStream, 30000);
          }
        };

        await pump();
      } catch (err: any) {
        if (err.name === 'AbortError') {
          this.log.debug('Stream aborted');
        } else {
          this.log.error(`Stream error: ${err.message}`);
          this.isStreaming = false;
          setTimeout(startStream, 30000);
        }
      } finally {
        if (this.isStreaming) {
          this.isStreaming = false;
        }
      }
    };

    startStream();
  }

  stopMonitoringEvents(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isStreaming = false;
    this.log.debug('Stream stopped');
  }

  private async _getResponse(path: string): Promise<any | undefined> {
    try {
      const url = `${this._baseURL}${path}`;

      const client = createLoggedDigestFetch(
        this.config.username,
        this.config.password,
        {
          algorithm: 'MD5',
          timeout: 8000,
          agent: new https.Agent({ rejectUnauthorized: !this.config.ignoreInsecureTls }),
        },
        (msg: string) => this.log.debug(msg),
      );

      const res = await client.fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/xml',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (res.status === 401) {
        this.log.error(`❌ Unauthorized (401): ${url}`);
        return;
      }

      const xml = await res.text();

      let responseJson: any;
      try {
        responseJson = this.xmlParser.parse(xml);
      } catch (e: any) {
        this.log.error(`❌ Failed to parse XML from ${url}: ${e.message}`);
        return;
      }

      this.connected = true;
      return responseJson;

    } catch (e: any) {
      this.log.error(`❌ ERROR: _getResponse ${path} -> ${e.message}`);
    }
  }

}