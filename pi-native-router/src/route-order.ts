import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface OrderItem { target: string; enabled: boolean }

/** Each interaction edits a draft; only Enter returns it to the command. */
export function orderEditor(items: readonly OrderItem[], done: (value: OrderItem[] | undefined) => void, render: () => void) {
  const draft = items.map(item => ({ ...item }));
  let selected = 0;
  return {
    invalidate() {},
    render(width: number) {
      const start = Math.max(0, selected - 7);
      return ["Route order (automatic routing)", "↑/↓ select · Shift+↑/↓ move · Space enable · Enter apply · Esc cancel",
        ...draft.slice(start, start + 15).map((item, index) => `${start + index === selected ? ">" : " "} [${item.enabled ? "x" : " "}] ${item.target}`)]
        .map(line => truncateToWidth(line, width));
    },
    handleInput(data: string) {
      if (matchesKey(data, Key.escape)) { done(undefined); return; }
      if (matchesKey(data, Key.enter)) { done(draft); return; }
      const move = matchesKey(data, Key.shift("up")) ? -1 : matchesKey(data, Key.shift("down")) ? 1 : 0;
      if (move) {
        const next = Math.max(0, Math.min(draft.length - 1, selected + move));
        [draft[selected], draft[next]] = [draft[next], draft[selected]];
        selected = next;
      } else if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
      else if (matchesKey(data, Key.down)) selected = Math.min(draft.length - 1, selected + 1);
      else if (matchesKey(data, Key.space)) draft[selected].enabled = !draft[selected].enabled;
      render();
    },
  };
}
