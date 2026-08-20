import type { AgentDisplayStatus } from '../../types/ui.js';

export interface OrbStyle {
  background: string;
  borderColor: string;
  boxShadow: string;
  tagColor: string;
  haloColor: string | null;
  blinking: boolean;
}

export function getOrbStyle(
  status: AgentDisplayStatus,
  color: string,
  selected: boolean,
): OrbStyle {
  const selectionRing = selected ? `, 0 0 0 2px ${color}` : '';

  switch (status) {
    case 'working':
    case 'waiting':
      return {
        background: `radial-gradient(circle at 32% 28%, ${color}, #12131f 70%)`,
        borderColor: color,
        boxShadow: `0 0 20px ${color}77, inset 0 0 12px ${color}33${selectionRing}`,
        tagColor: '#0a0b12',
        haloColor: `${color}66`,
        blinking: true,
      };
    case 'done':
      return {
        background: `radial-gradient(circle at 32% 28%, ${color}99, #10111c 70%)`,
        borderColor: `${color}66`,
        boxShadow: `0 0 10px ${color}33${selectionRing}`,
        tagColor: '#e8eaf2',
        haloColor: null,
        blinking: false,
      };
    case 'failed':
      return {
        background: `radial-gradient(circle at 32% 28%, #ff5b4599, #10111c 70%)`,
        borderColor: '#ff5b4566',
        boxShadow: `0 0 10px #ff5b4533${selectionRing}`,
        tagColor: '#e8eaf2',
        haloColor: null,
        blinking: false,
      };
    default: // queued
      return {
        background: 'radial-gradient(circle at 32% 28%, #3a4058, #0c0d16 70%)',
        borderColor: 'rgba(255,255,255,0.12)',
        boxShadow: selected ? `0 0 0 2px ${color}` : 'none',
        tagColor: '#7a8099',
        haloColor: null,
        blinking: false,
      };
  }
}

export function getStatusColor(status: AgentDisplayStatus): string {
  switch (status) {
    case 'working':
    case 'waiting':
      return '#ffb24d';
    case 'done':
      return '#37e0a0';
    case 'failed':
      return '#ff5b45';
    default:
      return '#6b7290';
  }
}

export function getStatusLabel(status: AgentDisplayStatus): string {
  switch (status) {
    case 'working':
      return 'WORKING';
    case 'waiting':
      return 'WAITING';
    case 'done':
      return 'DONE';
    case 'failed':
      return 'FAILED';
    default:
      return 'QUEUED';
  }
}
