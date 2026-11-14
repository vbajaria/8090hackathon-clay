'use client';
import { useEffect, useRef } from 'react';
export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return error ? <div className="error" role="alert">{error}{retry && <button onClick={retry}>Retry / reconcile saved state</button>}</div> : null;
}
export function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => el?.close(); }, []);
  return <dialog ref={dialog} onCancel={e => { e.preventDefault(); close(); }} aria-label={title}><div className="modal-head"><h2>{title}</h2><button onClick={close} aria-label="Close dialog">Close</button></div>{children}</dialog>;
}
export function Check({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <label className="check"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} disabled={disabled}/>{label}</label>;
}
export function ScopeSelect({ value, change, selected, allowBlank = false }: { value: string; change: (v: string) => void; selected: number; allowBlank?: boolean }) {
  return <label>Row scope<select value={value} onChange={e => change(e.target.value)}>{allowBlank && <option value="">Choose scope explicitly…</option>}<option value="selected" disabled={!selected}>Selected rows ({selected})</option><option value="filtered">All currently filtered rows (not just this page)</option><option value="all">All table rows</option></select></label>;
}
