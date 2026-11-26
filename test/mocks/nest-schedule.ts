// Scheduler infrastructure is not needed in unit tests. Avoid loading the
// ESM-only NestJS scheduler package or starting cron timers.
export const Cron =
  () =>
  (_target: object, _propertyKey: string, descriptor: PropertyDescriptor) =>
    descriptor;

export const CronExpression = {
  EVERY_MINUTE: '* * * * *',
  EVERY_HOUR: '0 * * * *',
  EVERY_DAY_AT_1AM: '0 1 * * *',
  EVERY_DAY_AT_3AM: '0 3 * * *',
};

export const ScheduleModule = {
  forRoot: () => ({ module: class ScheduleModuleMock {} }),
};
