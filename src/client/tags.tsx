import { isTimeTag, TIME_TAGS, type TimeTag } from "../contracts/tags";

export function tagLabel(tag: TimeTag): string {
  return TIME_TAGS.find((item) => item.id === tag)?.label ?? tag;
}

export function TagSelect({
  id,
  value,
  disabled = false,
  onChange,
}: {
  id: string;
  value: TimeTag | null;
  disabled?: boolean;
  onChange: (tag: TimeTag | null) => void;
}) {
  return (
    <div className="tag-field">
      <label htmlFor={id}>タグ（任意）</label>
      <select
        id={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => {
          const selected = event.target.value;
          if (selected === "" || isTimeTag(selected)) onChange(selected === "" ? null : selected);
        }}
      >
        <option value="">タグなし</option>
        {TIME_TAGS.map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function TagBadge({ tag }: { tag: TimeTag | null }) {
  if (tag === null) return null;
  return (
    <span className={`time-tag time-tag-${tag}`} title={tagLabel(tag)}>
      {tagLabel(tag)}
    </span>
  );
}
