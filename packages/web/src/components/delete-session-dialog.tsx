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
              <p>This will permanently delete this session and <strong>destroy its sandbox</strong>, freeing disk space on Daytona.</p>
              <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm">
                <p className="font-medium text-destructive">This cannot be undone.</p>
                <p className="mt-1 text-muted-foreground">
                  All session data, conversation history, and the running sandbox will be permanently removed.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Looking to just hide it? Use <strong>Archive</strong> instead — it keeps the sandbox alive so you can resume later.
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
