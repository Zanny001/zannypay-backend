import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';

describe('AppController', () => {
  let app: TestingModule;
  let prisma: { $queryRaw: jest.Mock };

  beforeAll(async () => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    app = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, { provide: PrismaService, useValue: prisma }],
    }).compile();
  });

  describe('getHello', () => {
    it('should return "Hello World!"', () => {
      const appController = app.get(AppController);
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('health', () => {
    it('reports ok when the database responds', async () => {
      const appController = app.get(AppController);
      const result = await appController.health();
      expect(result.status).toBe('ok');
      expect(result.database).toBe('connected');
    });

    it('throws ServiceUnavailable when the database is unreachable', async () => {
      prisma.$queryRaw.mockRejectedValueOnce(new Error('connection refused'));
      const appController = app.get(AppController);
      await expect(appController.health()).rejects.toThrow();
    });
  });
});
