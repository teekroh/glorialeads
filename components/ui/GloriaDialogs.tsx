"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from "react";

type DialogState =
  | { kind: "alert"; title: string; message: string; resolve: () => void }
  | { kind: "confirm"; title: string; message: string; resolve: (v: boolean) => void };

type GloriaDialogsApi = {
  alert: (message: string, title?: string) => Promise<void>;
  confirm: (message: string, title?: string) => Promise<boolean>;
};

const GloriaDialogContext = createContext<GloriaDialogsApi | null>(null);

export function useGloriaDialogs(): GloriaDialogsApi {
  const ctx = useContext(GloriaDialogContext);
  if (!ctx) {
    throw new Error("useGloriaDialogs must be used within GloriaDialogProvider");
  }
  return ctx;
}

export function GloriaDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState | null>(null);

  const alert = useCallback((message: string, title = "Notice") => {
    return new Promise<void>((resolve) => {
      setState({
        kind: "alert",
        title,
        message,
        resolve: () => {
          resolve();
          setState(null);
        }
      });
    });
  }, []);

  const confirm = useCallback((message: string, title = "Confirm") => {
    return new Promise<boolean>((resolve) => {
      setState({
        kind: "confirm",
        title,
        message,
        resolve: (v) => {
          resolve(v);
          setState(null);
        }
      });
    });
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (state.kind === "alert") state.resolve();
        else state.resolve(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  return (
    <GloriaDialogContext.Provider value={{ alert, confirm }}>
      {children}
      {state ? (
        <div
          className="fixed inset-0 z-[130] flex items-center justify-center bg-black/45 p-4"
          role="presentation"
          onClick={() => {
            if (state.kind === "alert") state.resolve();
            else state.resolve(false);
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="gloria-dialog-title"
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="gloria-dialog-title" className="text-lg font-semibold text-brand-ink">
              {state.title}
            </h2>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-brand-ink/90">{state.message}</p>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              {state.kind === "confirm" ? (
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-brand-ink/90 hover:bg-slate-50"
                  onClick={() => state.resolve(false)}
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
                onClick={() => (state.kind === "alert" ? state.resolve() : state.resolve(true))}
              >
                {state.kind === "confirm" ? "Continue" : "OK"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </GloriaDialogContext.Provider>
  );
}
