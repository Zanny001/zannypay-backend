// The scheduler is infrastructure; unit tests exercise service behavior
// without starting cron timers or loading its ESM-only package.
export const Cron = (...decoratorArgs: unknown[]) => {
  void decoratorArgs;
  return (
    target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) => {
    void target;
    void propertyKey;
    return descriptor;
  };
};

export const CronExpression = {
  EVERY_HOUR: '0 * * * *',
  EVERY_DAY_AT_1AM: '0 1 * * *',
  EVERY_DAY_AT_3AM: '0 3 * * *',
};

export const ScheduleModule = {
  forRoot: () => ({ module: class ScheduleModuleMock {} }),
};
