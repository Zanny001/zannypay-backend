// The scheduler is an infrastructure integration. Unit tests exercise
// service behavior without starting cron timers or loading its ESM package.
export const Cron = (..._args: unknown[]) => (
  _target: object,
  _propertyKey: string,
  _descriptor: PropertyDescriptor,
) => undefined;

export const CronExpression = {
  EVERY_HOUR: '0 * * * *',
  EVERY_DAY_AT_1AM: '0 1 * * *',
  EVERY_DAY_AT_3AM: '0 3 * * *',
};

export const ScheduleModule = {
  forRoot: () => ({ module: class ScheduleModuleMock {} }),
};
