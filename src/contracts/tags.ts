/** Fixed, optional categories shared by the client and API without runtime dependencies. */
export const TIME_TAGS = [
  { id: "work", label: "仕事" },
  { id: "housework", label: "家事" },
  { id: "self_development", label: "自己研鑽" },
  { id: "chores", label: "雑務" },
  { id: "hobby", label: "趣味の時間" },
  { id: "relaxation", label: "だらけた時間" },
] as const;

export type TimeTag = (typeof TIME_TAGS)[number]["id"];

export function isTimeTag(value: unknown): value is TimeTag {
  return TIME_TAGS.some(({ id }) => id === value);
}
