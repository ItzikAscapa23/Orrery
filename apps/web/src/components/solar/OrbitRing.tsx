import type { RingConfig } from './ringConfig.js';
import type { AgentDisplayStatus } from '../../types/ui.js';

interface OrbitRingProps {
  config: RingConfig;
  agentStatuses: Record<string, AgentDisplayStatus>;
}

export function OrbitRing({ config, agentStatuses }: OrbitRingProps) {
  const size = config.radius * 2;
  const isLit = config.agents.some(
    (id) => agentStatuses[id] === 'working' || agentStatuses[id] === 'waiting',
  );

  const classes = ['orbit-ring', `ring-${config.id}`, isLit ? config.litClass : '']
    .filter(Boolean)
    .join(' ');

  return <div className={classes} style={{ width: size, height: size }} aria-hidden="true" />;
}
