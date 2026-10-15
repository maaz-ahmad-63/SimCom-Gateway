import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

export function formatTimeOnly(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

export function getOutcomeBadge(outcome: string | null | undefined): {
  label: string;
  className: string;
} {
  switch (outcome) {
    case 'completed':
      return { label: 'Completed', className: 'bg-emerald-950/80 text-emerald-400 border-emerald-800/60' };
    case 'missed':
      return { label: 'Missed', className: 'bg-amber-950/80 text-amber-400 border-amber-800/60' };
    case 'rejected':
      return { label: 'Rejected', className: 'bg-rose-950/80 text-rose-400 border-rose-800/60' };
    case 'busy':
      return { label: 'Busy', className: 'bg-orange-950/80 text-orange-400 border-orange-800/60' };
    case 'busy_rejected':
      return { label: 'Busy (Auto-Rejected)', className: 'bg-red-950/80 text-red-400 border-red-800/60' };
    case 'failed':
      return { label: 'Failed', className: 'bg-red-950/80 text-red-400 border-red-800/60' };
    case 'no_answer':
      return { label: 'No Answer', className: 'bg-slate-800 text-slate-300 border-slate-700' };
    default:
      return { label: outcome || 'Unknown', className: 'bg-slate-800 text-slate-400 border-slate-700' };
  }
}

export function validatePhoneNumber(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone.trim());
}
