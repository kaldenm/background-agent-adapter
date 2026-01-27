"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import { useSession, signOut } from "next-auth/react";
import { formatRelativeTime, isInactiveSession } from "@/lib/time";

export interface SessionItem {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionSidebarProps {
  onNewSession?: () => void;
  onToggle?: () => void;
}

export function SessionSidebar({ onNewSession, onToggle }: SessionSidebarProps) {
  const { data: authSession } = useSession();
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (authSession) {
      fetchSessions();
    }
  }, [authSession]);

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (error) {
      console.error("Failed to fetch sessions:", error);
    } finally {
      setLoading(false);
    }
  };

  // Sort sessions by updatedAt (most recent first) and filter by search query
  const { activeSessions, inactiveSessions } = useMemo(() => {
    const filtered = sessions.filter((session) => {
      if (!searchQuery) return true;
      const query = searchQuery.toLowerCase();
      const title = session.title?.toLowerCase() || "";
      const repo = `${session.repoOwner}/${session.repoName}`.toLowerCase();
      return title.includes(query) || repo.includes(query);
    });

    // Sort by updatedAt descending
    const sorted = [...filtered].sort((a, b) => {
      const aTime = a.updatedAt || a.createdAt;
      const bTime = b.updatedAt || b.createdAt;
      return bTime - aTime;
    });

    const active: SessionItem[] = [];
    const inactive: SessionItem[] = [];

    for (const session of sorted) {
      const timestamp = session.updatedAt || session.createdAt;
      if (isInactiveSession(timestamp)) {
        inactive.push(session);
      } else {
        active.push(session);
      }
    }

    return { activeSessions: active, inactiveSessions: inactive };
  }, [sessions, searchQuery]);

  const currentSessionId = pathname?.startsWith("/session/") ? pathname.split("/")[2] : null;

  return (
    <aside className="w-72 h-screen flex flex-col border-r border-black/5 dark:border-white/5 bg-[#F8F8F6] dark:bg-[#1a1a1a]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/5">
        <div className="flex items-center gap-2">
          <button
            onClick={onToggle}
            className="p-1.5 text-[#666666] hover:text-[#1a1a1a] dark:text-[#999999] dark:hover:text-[#F8F8F6] hover:bg-black/5 dark:hover:bg-white/5 transition"
            title="Toggle sidebar"
          >
            <SidebarIcon />
          </button>
          <Link href="/" className="flex items-center gap-2">
            <InspectIcon />
            <span className="font-semibold text-[#1a1a1a] dark:text-[#F8F8F6]">Inspect</span>
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onNewSession}
            className="p-1.5 text-[#666666] hover:text-[#1a1a1a] dark:text-[#999999] dark:hover:text-[#F8F8F6] hover:bg-black/5 dark:hover:bg-white/5 transition"
            title="New session"
          >
            <PlusIcon />
          </button>
          {authSession?.user?.image ? (
            <button
              onClick={() => signOut()}
              className="w-7 h-7 rounded-full overflow-hidden"
              title={`Signed in as ${authSession.user.name}\nClick to sign out`}
            >
              <img
                src={authSession.user.image}
                alt={authSession.user.name || "User"}
                className="w-full h-full object-cover"
              />
            </button>
          ) : (
            <button
              onClick={() => signOut()}
              className="w-7 h-7 rounded-full bg-[#F8F8F6] dark:bg-white/10 flex items-center justify-center text-xs font-medium text-[#1a1a1a] dark:text-[#F8F8F6]"
              title="Sign out"
            >
              {authSession?.user?.name?.charAt(0).toUpperCase() || "?"}
            </button>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <input
          type="text"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-white/50 dark:bg-white/5 border border-black/10 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-[#8B7355] dark:focus:ring-[#a68b6a] focus:border-transparent placeholder-[#999999] text-[#1a1a1a] dark:text-[#F8F8F6]"
        />
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[#666666]" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[#666666] dark:text-[#999999]">
            No sessions yet
          </div>
        ) : (
          <>
            {/* Active Sessions */}
            {activeSessions.map((session) => (
              <SessionListItem
                key={session.id}
                session={session}
                isActive={session.id === currentSessionId}
              />
            ))}

            {/* Inactive Divider */}
            {inactiveSessions.length > 0 && (
              <>
                <div className="px-4 py-2 mt-2">
                  <span className="text-xs font-medium text-[#999999] uppercase tracking-wide">
                    Inactive
                  </span>
                </div>
                {inactiveSessions.map((session) => (
                  <SessionListItem
                    key={session.id}
                    session={session}
                    isActive={session.id === currentSessionId}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function SessionListItem({ session, isActive }: { session: SessionItem; isActive: boolean }) {
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const displayTitle = session.title || `${session.repoOwner}/${session.repoName}`;
  const repoInfo = `${session.repoOwner}/${session.repoName}`;

  return (
    <Link
      href={`/session/${session.id}`}
      className={`block px-4 py-2.5 border-l-2 transition ${
        isActive
          ? "border-l-[#8B7355] bg-[#8B7355]/10 dark:bg-[#8B7355]/20"
          : "border-l-transparent hover:bg-black/5 dark:hover:bg-white/5"
      }`}
    >
      <div className="truncate text-sm font-medium text-[#1a1a1a] dark:text-[#F8F8F6]">
        {displayTitle}
      </div>
      <div className="flex items-center gap-1 mt-0.5 text-xs text-[#666666] dark:text-[#999999]">
        <span>{relativeTime}</span>
        <span>·</span>
        <span className="truncate">{repoInfo}</span>
      </div>
    </Link>
  );
}

function InspectIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function SidebarIcon() {
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
