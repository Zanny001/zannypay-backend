import { Test, TestingModule } from '@nestjs/testing';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { VtpassClient } from './vtpass.client';
import { VtpassPaymentsService } from './vtpass-payments.service';

describe('TransactionsController', () => {
  let controller: TransactionsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [
        {
          provide: TransactionsService,
          useValue: { transferFunds: jest.fn() },
        },
        {
          provide: VtpassClient,
          useValue: {
            getServices: jest.fn(),
            getServiceVariations: jest.fn(),
            verifyCustomer: jest.fn(),
          },
        },
        {
          provide: VtpassPaymentsService,
          useValue: { purchase: jest.fn(), getTransaction: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<TransactionsController>(TransactionsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
