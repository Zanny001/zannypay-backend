import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CardsService {
  constructor(private prisma: PrismaService) {}

  async getCards(userId: string) {
    return this.prisma.card.findMany({
      where: { userId },
    });
  }

  async createCard(userId: string) {
    // Check if the user already has a card to prevent duplicates
    const existingCard = await this.prisma.card.findFirst({ where: { userId } });
    if (existingCard) {
      throw new BadRequestException('You already have an active virtual card.');
    }

    // Generate random mock card parameters
    const randomDigits = Math.floor(10000000 + Math.random() * 90000000).toString();
    const cardNumber = `54127589${randomDigits}`; // standard Mastercard structure
    const cvv = Math.floor(100 + Math.random() * 900).toString();
    
    // Set expiration 4 years from now
    const now = new Date();
    const expiryMonth = String(now.getMonth() + 1).padStart(2, '0');
    const expiryYear = String(now.getFullYear() + 4).slice(-2);
    const expiry = `${expiryMonth}/${expiryYear}`;

    return this.prisma.card.create({
      data: {
        userId,
        cardNumber,
        cvv,
        expiry,
        type: 'VIRTUAL ULTRA',
        isFrozen: false,
      },
    });
  }

  async toggleFreeze(userId: string, cardId: string, isFrozen: boolean) {
    const card = await this.prisma.card.findFirst({
      where: { id: cardId, userId },
    });

    if (!card) {
      throw new NotFoundException('Virtual card not found.');
    }

    return this.prisma.card.update({
      where: { id: cardId },
      data: { isFrozen },
    });
  }
}
