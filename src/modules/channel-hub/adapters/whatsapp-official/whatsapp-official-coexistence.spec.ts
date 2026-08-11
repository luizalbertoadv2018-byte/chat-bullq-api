import { WhatsAppOfficialInboundAdapter } from './whatsapp-official.inbound-adapter';
import { WhatsAppOfficialMessageMapper } from './whatsapp-official.message-mapper';
import { Channel } from '@prisma/client';

const mapper = new WhatsAppOfficialMessageMapper();
const adapter = new WhatsAppOfficialInboundAdapter(mapper);

const channel = {
  id: 'chan-1',
  config: { phoneNumberId: 'PN-1' },
} as unknown as Channel;

describe('WA Official — coexistência', () => {
  it('smb_message_echoes vira mensagem de SAÍDA (isEcho) com o cliente como contato', () => {
    const payload = {
      entry: [
        {
          id: 'WABA-1',
          changes: [
            {
              field: 'smb_message_echoes',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+55 62 90000-0000',
                  phone_number_id: 'PN-1',
                },
                message_echoes: [
                  {
                    id: 'wamid.ECHO1',
                    from: '5562900000000', // nós (o negócio)
                    to: '5511988887777', // cliente
                    timestamp: '1784638025',
                    type: 'text',
                    text: { body: 'Respondido pelo celular' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = adapter.parseWebhook(payload, channel);
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg.isEcho).toBe(true);
    expect(msg.externalContactId).toBe('5511988887777');
    expect(msg.contactPhone).toBe('5511988887777');
    expect(msg.content.text).toBe('Respondido pelo celular');
  });

  it('history: inbound do cliente e eco nosso são direcionados corretamente', () => {
    const payload = {
      entry: [
        {
          id: 'WABA-1',
          changes: [
            {
              field: 'history',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+55 62 90000-0000',
                  phone_number_id: 'PN-1',
                },
                history: [
                  {
                    metadata: { phase: 0, chunk_order: 1, progress: 100 },
                    threads: [
                      {
                        id: '5511988887777',
                        messages: [
                          {
                            id: 'wamid.HIST_IN',
                            from: '5511988887777', // cliente
                            to: '5562900000000',
                            timestamp: '1784600000',
                            type: 'text',
                            text: { body: 'Oi, tudo bem?' },
                          },
                          {
                            id: 'wamid.HIST_OUT',
                            from: '5562900000000', // nós
                            to: '5511988887777',
                            timestamp: '1784600100',
                            type: 'text',
                            text: { body: 'Tudo! Como posso ajudar?' },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = adapter.parseWebhook(payload, channel);
    expect(result.messages).toHaveLength(2);

    const inbound = result.messages.find((m) => m.externalMessageId === 'wamid.HIST_IN')!;
    expect(inbound.isEcho).toBe(false);
    expect(inbound.externalContactId).toBe('5511988887777');

    const outbound = result.messages.find((m) => m.externalMessageId === 'wamid.HIST_OUT')!;
    expect(outbound.isEcho).toBe(true);
    expect(outbound.externalContactId).toBe('5511988887777');
  });

  it('extractLocators reconhece phone_number_id em eventos de coexistência', () => {
    const payload = {
      entry: [
        {
          id: 'WABA-1',
          changes: [
            {
              field: 'smb_message_echoes',
              value: { metadata: { phone_number_id: 'PN-1' }, message_echoes: [] },
            },
          ],
        },
      ],
    };
    const locators = adapter.extractLocators(payload);
    expect(locators).toEqual([{ phoneNumberId: 'PN-1', businessAccountId: 'WABA-1' }]);
    expect(adapter.matchesChannel(channel, locators[0])).toBe(true);
  });
});
