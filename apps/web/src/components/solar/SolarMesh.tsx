import { useEffect, useRef, useState } from 'react';
import type { AgentId } from '@orrery/shared';
import type { AgentDisplayStatus, PhaseId, SelectedEntity } from '../../types/ui.js';
import { RINGS, PLANETS, getRingForAgent } from './ringConfig.js';
import { OrbitRing } from './OrbitRing.js';
import { Planet } from './Planet.js';
import { Sun } from './Sun.js';
import { productName } from '../../lib/productName.js';
import '../../styles/solar.css';

interface SolarMeshProps {
  phase: PhaseId;
  agentStatuses: Record<string, AgentDisplayStatus>;
  selected: SelectedEntity;
  motionEnabled: boolean;
  onSelect: (entity: SelectedEntity) => void;
}

export function SolarMesh({
  phase,
  agentStatuses,
  selected,
  motionEnabled,
  onSelect,
}: SolarMeshProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const s = Math.min(1, Math.max(0.3, Math.min(width / 745, height / 745)));
      setScale(s);
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="solar-mesh" ref={paneRef}>
      <div className="solar-watermark">{productName()} / Solar Mesh · Heliocentric View</div>

      {/* Scale wrapper — zero-size anchor at pane center */}
      <div
        className="solar-scale-wrapper"
        style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
        aria-label="Solar system visualization"
      >
        {/* Orbit rings */}
        {RINGS.map((ring) => (
          <OrbitRing key={ring.id} config={ring} agentStatuses={agentStatuses} />
        ))}

        {/* Planets */}
        {PLANETS.map((planetConfig) => {
          const ring = getRingForAgent(planetConfig.agentId);
          const status = agentStatuses[planetConfig.agentId] ?? 'queued';
          return (
            <Planet
              key={planetConfig.agentId}
              config={planetConfig}
              ring={ring}
              status={status}
              selected={selected}
              motionEnabled={motionEnabled}
              onSelect={(id: AgentId) => onSelect(id)}
            />
          );
        })}

        {/* Sun */}
        <Sun
          phase={phase}
          selected={selected}
          motionEnabled={motionEnabled}
          onSelect={() => onSelect('orchestrator')}
        />
      </div>
    </div>
  );
}
