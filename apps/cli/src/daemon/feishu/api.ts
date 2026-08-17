import * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuConfig } from './types.js'

export interface FeishuApi {
  sendText(openId: string, text: string): Promise<void>
}

export function createFeishuApi(config: FeishuConfig): FeishuApi {
  const client = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  })
  return {
    async sendText(openId: string, text: string): Promise<void> {
      await client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
      })
    },
  }
}
