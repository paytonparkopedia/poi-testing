import { JobConfiguration } from '@poi-testing/shared';

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

export interface QuotePayload {
  parking_payment_zone_id?: string;
  location_id?: string;
  location_space_id?: string;
}

export interface PaymentResponse {
  id?: string;
  result?: {
    id?: string;
  };
}

export class ParkopediaAPIClient {
  private baseUrl: string;
  private uid: string;
  private cid: string;
  private userId: string;
  private apiver: string;
  private clientId: string;
  private clientSecret: string;
  private username: string;
  private password: string;
  private token: string | null = null;
  private tokenExpiresAt: number | null = null;

  constructor(config: JobConfiguration & {
    client_id: string;
    client_secret: string;
    username: string;
    password: string;
  }) {
    this.baseUrl = config.base_url;
    this.uid = config.uid;
    this.cid = config.cid;
    this.userId = config.user_id;
    this.apiver = config.apiver;
    this.clientId = config.client_id;
    this.clientSecret = config.client_secret;
    this.username = config.username;
    this.password = config.password;
  }

  async getToken(): Promise<string> {
    // Check if token is still valid (with 5 min buffer)
    if (this.token && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt - 300000) {
      return this.token;
    }

    const url = `${this.baseUrl}/api/tokens/?uid=${this.uid}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        username: this.username,
        password: this.password,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get token: ${response.status} ${text}`);
    }

    const data = await response.json() as TokenResponse;
    this.token = data.access_token;
    // Default to 1 hour if not specified
    this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return this.token;
  }

  async requestQuote(
    payload: QuotePayload,
    startTimeUtc: string,
    stopTimeUtc: string
  ): Promise<{ status: number; data?: any; error?: string }> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/api/users/${this.userId}/paymentsquotes/?start_time_utc=${encodeURIComponent(startTimeUtc)}&stop_time_utc=${encodeURIComponent(stopTimeUtc)}&uid=${this.uid}&cid=${this.cid}&apiver=${this.apiver}`;

    console.log('[API REQUEST] Quote Request:');
    console.log('  URL:', url);
    console.log('  Method: POST');
    console.log('  Payload:', JSON.stringify(payload, null, 2));
    console.log('  Headers:', { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.substring(0, 20)}...` });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const text = await response.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      console.log('[API RESPONSE] Quote Response:');
      console.log('  Status:', response.status, response.statusText);
      console.log('  Response Body:', text.substring(0, 500)); // First 500 chars
      if (data) {
        console.log('  Parsed Data:', JSON.stringify(data, null, 2).substring(0, 500));
      }

      // Check for errors in response body (even if status is 201)
      if (data && (data.error || data.status === 'ERROR')) {
        const errorText = data.error || JSON.stringify(data);
        console.log('[API ERROR] Quote failed (error in response body):', response.status, errorText);
        return {
          status: response.status,
          error: errorText,
        };
      }

      if (!response.ok) {
        console.log('[API ERROR] Quote failed:', response.status, text);
        return {
          status: response.status,
          error: text || `HTTP ${response.status}`,
        };
      }

      console.log('[API SUCCESS] Quote succeeded');
      return { status: response.status, data };
    } catch (error: any) {
      console.error('[API ERROR] Quote exception:', error.message, error.stack);
      return {
        status: 0,
        error: error.message || 'Network error',
      };
    }
  }

  async startPayment(
    payload: QuotePayload & { start_time_utc: string },
    startTimeUtc: string,
    stopTimeUtc: string
  ): Promise<{ status: number; paymentId?: string; error?: string }> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/api/users/${this.userId}/payments/?uid=${this.uid}&cid=${this.cid}&apiver=${this.apiver}`;

    const requestBody = {
      ...payload,
      start_time_utc: startTimeUtc,
    };

    console.log('[API REQUEST] Start Payment:');
    console.log('  URL:', url);
    console.log('  Method: POST');
    console.log('  Payload:', JSON.stringify(requestBody, null, 2));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });

      const text = await response.text();
      let data: PaymentResponse | null;
      try {
        data = text ? (JSON.parse(text) as PaymentResponse) : null;
      } catch {
        data = null;
      }

      console.log('[API RESPONSE] Start Payment Response:');
      console.log('  Status:', response.status, response.statusText);
      console.log('  Response Body:', text.substring(0, 500));

      // Check for errors in response body (even if status is 201)
      if (data && (data as any).error) {
        const errorText = (data as any).error || JSON.stringify(data);
        console.log('[API ERROR] Start Payment failed (error in response body):', response.status, errorText);
        return {
          status: response.status,
          error: errorText,
        };
      }

      if (!response.ok) {
        console.log('[API ERROR] Start Payment failed:', response.status, text);
        return {
          status: response.status,
          error: text || `HTTP ${response.status}`,
        };
      }

      const paymentId = data ? (data.id || data.result?.id) : null;
      if (!paymentId) {
        console.log('[API ERROR] No payment ID in response');
        return {
          status: response.status,
          error: 'No payment ID in response',
        };
      }

      console.log('[API SUCCESS] Start Payment succeeded, Payment ID:', paymentId);
      return { status: response.status, paymentId };
    } catch (error: any) {
      console.error('[API ERROR] Start Payment exception:', error.message, error.stack);
      return {
        status: 0,
        error: error.message || 'Network error',
      };
    }
  }

  async stopPayment(paymentId: string): Promise<{ status: number; error?: string }> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/api/users/${this.userId}/payments/${paymentId}/?uid=${this.uid}&cid=${this.cid}&apiver=${this.apiver}`;

    console.log('[API REQUEST] Stop Payment:');
    console.log('  URL:', url);
    console.log('  Method: DELETE');
    console.log('  Payment ID:', paymentId);

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const text = await response.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      console.log('[API RESPONSE] Stop Payment Response:');
      console.log('  Status:', response.status, response.statusText);
      console.log('  Response Body:', text.substring(0, 500));

      // Check for errors in response body (even if status is 204)
      if (data && data.error) {
        const errorText = data.error || JSON.stringify(data);
        console.log('[API ERROR] Stop Payment failed (error in response body):', response.status, errorText);
        return {
          status: response.status,
          error: errorText,
        };
      }

      if (!response.ok) {
        console.log('[API ERROR] Stop Payment failed:', response.status, text);
        return {
          status: response.status,
          error: text || `HTTP ${response.status}`,
        };
      }

      console.log('[API SUCCESS] Stop Payment succeeded');
      return { status: response.status };
    } catch (error: any) {
      console.error('[API ERROR] Stop Payment exception:', error.message, error.stack);
      return {
        status: 0,
        error: error.message || 'Network error',
      };
    }
  }
}
