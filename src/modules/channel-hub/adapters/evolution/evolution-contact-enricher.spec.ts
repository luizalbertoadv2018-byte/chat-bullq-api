import { Channel } from '@prisma/client';
import { EvolutionContactEnricherService } from './evolution-contact-enricher.service';

const channel = { id: 'ch_1' } as unknown as Channel;
const EXTERNAL_ID = '5562999999999@s.whatsapp.net';
const LOCAL = 'https://app/avatars/c_1.jpg?v=abc';

function build(contact: Record<string, any>, pictureUrl: string | null) {
  const prisma: any = {
    contactChannel: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'cc_1',
        contactId: 'c_1',
        profileAvatarUrl: null,
        contact: {
          id: 'c_1',
          organizationId: 'org_1',
          name: 'Fulano',
          avatarUrl: null,
          metadata: {},
          ...contact,
        },
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    contact: { update: jest.fn().mockResolvedValue({}) },
  };
  const httpClient: any = {
    fetchProfilePictureUrl: jest.fn().mockResolvedValue(pictureUrl),
    getMediaBuffer: jest.fn().mockResolvedValue(Buffer.from('jpg')),
  };
  const uploads: any = {
    // Só a URL do nosso storage tem arquivo por trás.
    avatarAgeInDays: (url: string | null) => (url === LOCAL ? 1 : null),
    saveAvatar: jest.fn().mockResolvedValue(LOCAL),
  };
  const realtime: any = { emitToOrg: jest.fn() };
  return {
    service: new EvolutionContactEnricherService(prisma, httpClient, uploads, realtime),
    prisma,
    httpClient,
    realtime,
  };
}

describe('EvolutionContactEnricherService', () => {
  it('baixa a foto, grava no contato e avisa o inbox', async () => {
    const { service, prisma, realtime } = build({}, 'https://pps.whatsapp.net/x.jpg');
    await service.enrich(channel, EXTERNAL_ID);
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'c_1' },
      data: { avatarUrl: LOCAL },
    });
    expect(realtime.emitToOrg).toHaveBeenCalledWith(
      'org_1',
      'contact:avatar',
      expect.objectContaining({ contactId: 'c_1', avatarUrl: LOCAL }),
    );
  });

  it('rebusca quando a URL gravada é de outro ambiente', async () => {
    const { service, httpClient } = build(
      { avatarUrl: 'http://localhost:3001/api/v1/uploads/avatars/c_1.jpg' },
      'https://pps.whatsapp.net/x.jpg',
    );
    await service.enrich(channel, EXTERNAL_ID);
    expect(httpClient.fetchProfilePictureUrl).toHaveBeenCalled();
  });

  it('não vai ao provider se a foto local está em dia', async () => {
    const { service, httpClient } = build({ avatarUrl: LOCAL }, null);
    await service.enrich(channel, EXTERNAL_ID);
    expect(httpClient.fetchProfilePictureUrl).not.toHaveBeenCalled();
  });

  it('não repergunta por quem não tem foto se já tentamos hoje', async () => {
    const { service, httpClient } = build(
      { metadata: { avatarCheckedAt: new Date().toISOString() } },
      null,
    );
    await service.enrich(channel, EXTERNAL_ID);
    expect(httpClient.fetchProfilePictureUrl).not.toHaveBeenCalled();
  });

  it('contato sem foto não quebra nem emite evento', async () => {
    const { service, realtime } = build({}, null);
    await service.enrich(channel, EXTERNAL_ID);
    expect(realtime.emitToOrg).not.toHaveBeenCalled();
  });
});
