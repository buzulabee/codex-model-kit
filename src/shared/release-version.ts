export function releaseTag(version: string): string {
  const match = /^(\d{4})\.([1-9]\d{2,3})\.(0|[1-9]\d{0,3})$/.exec(version);
  if (!match)
    throw new Error("Expected a numeric Shanghai release-minute version");
  const [, year, date, time] = match;
  return `v${year}.${date!.padStart(4, "0")}.${time!.padStart(4, "0")}`;
}
