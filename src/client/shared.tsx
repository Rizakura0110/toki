import { type ReactNode, useEffect, useRef } from "react";
import { useHref, useLinkClickHandler } from "react-router";

// Declarative navigation only. The official hooks preserve modified clicks and
// history without bundling Framework Mode's unused dynamic route-module loader.
function PageLink({
  to,
  children,
  ...props
}: {
  to: "/" | "/calendar.html";
  children: ReactNode;
  className: string;
  "aria-label"?: string;
}) {
  const href = useHref(to);
  const onClick = useLinkClickHandler<HTMLAnchorElement>(to);
  return (
    <a {...props} href={href} onClick={onClick}>
      {children}
    </a>
  );
}

export function Header({ calendar }: { calendar: boolean }) {
  const brand = (
    <>
      <span className="brand-mark" aria-hidden="true" />
      <span>Toki</span>
    </>
  );
  return (
    <header className="site-header">
      <div className="site-header-inner">
        {calendar ? (
          <PageLink className="brand calendar-brand" to="/" aria-label="Toki の計測画面へ">
            {brand}
          </PageLink>
        ) : (
          <div className="brand">{brand}</div>
        )}
        <nav aria-label="Toki のページ">
          <a className="portal-return" href="https://rizakura-hontai.sx7k2p9q.workers.dev/">
            ← rizakura-hontaiへ戻る
          </a>
          <PageLink className="button button-outline" to={calendar ? "/" : "/calendar.html"}>
            {calendar ? "計測画面へ" : "カレンダーを見る"} <span aria-hidden="true">→</span>
          </PageLink>
        </nav>
      </div>
    </header>
  );
}

/** Native modal focus containment/backdrop, driven only by React state. */
export function Modal({
  id,
  open,
  cancel,
  children,
}: {
  id: string;
  open: boolean;
  cancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector("input")?.focus();
    } else if (!open && dialog?.open) dialog.close();
  }, [open]);
  return (
    <dialog
      id={`${id}-dialog`}
      ref={ref}
      className="edit-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      onClose={() => {
        if (open) cancel();
      }}
    >
      {children}
    </dialog>
  );
}
