"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface DeleteSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function DeleteSessionDialog({ open, onOpenChange, onConfirm }: DeleteSessionDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete session permanently?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                This will permanently delete this session from the app. If a Daytona sandbox is
                attached, the server will attempt to clean it up.
              </p>
              <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm">
                <p className="font-medium text-destructive">This cannot be undone.</p>
                <p className="mt-1 text-muted-foreground">
                  Session data and conversation history will be removed. Sandbox cleanup is
                  best-effort when the provider supports it.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Looking to just hide it? Use <strong>Archive</strong> instead so you can resume
                later.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
