import { EvolutionMessageMapper } from './evolution.message-mapper';

describe('EvolutionMessageMapper — envelopes sem conteúdo', () => {
  const mapper = new EvolutionMessageMapper();
  const key = { id: 'A1', remoteJid: '5564999999999@s.whatsapp.net', fromMe: false };

  it('ignora o anúncio de álbum de fotos', () => {
    expect(
      mapper.normalizeInbound({ key, message: { albumMessage: { expectedImageCount: 2 } } }),
    ).toBeNull();
  });

  it('continua aceitando a foto do álbum', () => {
    const out = mapper.normalizeInbound({
      key,
      message: { imageMessage: { mimetype: 'image/jpeg' }, messageContextInfo: {} },
    });
    expect(out?.type).toBe('IMAGE');
  });

  it('texto normal segue normal', () => {
    const out = mapper.normalizeInbound({ key, message: { conversation: 'oi' } });
    expect((out?.content as any).text).toBe('oi');
  });
});
