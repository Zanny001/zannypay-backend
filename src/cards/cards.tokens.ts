// Interface-typed DI tokens — TypeScript interfaces don't exist at
// runtime, so `@Inject(CardIssuingProvider)` wouldn't work; these string
// tokens are what cards.module.ts binds a concrete class to, and what
// CardsService's constructor asks for via @Inject().
export const CARD_ISSUING_PROVIDER = 'CARD_ISSUING_PROVIDER';
export const CARD_LINKING_PROVIDER = 'CARD_LINKING_PROVIDER';
