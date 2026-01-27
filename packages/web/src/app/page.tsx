"use client";

import { useRouter } from "next/navigation";
import { SidebarLayout, useSidebarContext } from "@/components/sidebar-layout";

export default function Home() {
  const router = useRouter();

  return (
    <SidebarLayout>
      <HomeContent onNewSession={() => router.push("/session/new")} />
    </SidebarLayout>
  );
}

function HomeContent({ onNewSession }: { onNewSession: () => void }) {
  const { isOpen, toggle } = useSidebarContext();

  return (
    <div className="h-full flex flex-col">
      {/* Header with toggle when sidebar is closed */}
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <button
              onClick={toggle}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
              title="Open sidebar"
            >
              <SidebarToggleIcon />
            </button>
          </div>
        </header>
      )}

      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="max-w-xl text-center">
          <h1 className="text-3xl font-semibold text-foreground mb-4">Welcome to Open-Inspect</h1>
          <p className="text-muted-foreground mb-8">
            Select a session from the sidebar or create a new one to get started.
          </p>
          <button
            onClick={onNewSession}
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-6 py-3 font-medium hover:opacity-90 transition"
          >
            <PlusIcon />
            New Session
          </button>
        </div>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function SidebarToggleIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}
