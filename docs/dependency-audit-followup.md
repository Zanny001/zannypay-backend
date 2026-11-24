# Dependency audit follow-up

The security branch runs a non-forced npm audit fix, then validates install, tests, build, formatting and lint. Any remaining advisories must be reviewed individually and must not be suppressed by force-upgrading unrelated major dependencies.
