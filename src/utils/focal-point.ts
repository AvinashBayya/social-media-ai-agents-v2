/**
 * Spatio-Temporal Focal Point Convergence Engine
 *
 * Detects spatial and temporal clustering across heterogeneous OSINT events
 * (Earthquakes, Conflict Events, Social Posts, Cyber Threats) to flag
 * emerging geographic hotspots.
 */

export interface GeoEventInput {
  id: string;
  lat: number;
  lon: number;
  timestamp: string;
  title: string;
  source: string;
}

export interface FocalPointCluster {
  id: string;
  centerLat: number;
  centerLon: number;
  eventCount: number;
  regionName: string;
  events: GeoEventInput[];
  convergenceScore: number;
}

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function detectFocalPoints(
  events: GeoEventInput[],
  radiusKm = 200,
  timeWindowHours = 48,
): FocalPointCluster[] {
  const validEvents = events.filter(
    (e) => Number.isFinite(e.lat) && Number.isFinite(e.lon) && (e.lat !== 0 || e.lon !== 0),
  );
  if (validEvents.length < 2) return [];

  const clusters: FocalPointCluster[] = [];
  const visited = new Set<string>();

  for (let i = 0; i < validEvents.length; i++) {
    const e1 = validEvents[i];
    if (visited.has(e1.id)) continue;

    const group: GeoEventInput[] = [e1];
    visited.add(e1.id);

    const t1 = new Date(e1.timestamp).getTime();

    for (let j = i + 1; j < validEvents.length; j++) {
      const e2 = validEvents[j];
      if (visited.has(e2.id)) continue;

      const dist = haversineDistanceKm(e1.lat, e1.lon, e2.lat, e2.lon);
      const t2 = new Date(e2.timestamp).getTime();
      const timeDiffHours = Math.abs(t1 - t2) / (1000 * 60 * 60);

      if (dist <= radiusKm && (isNaN(timeDiffHours) || timeDiffHours <= timeWindowHours)) {
        group.push(e2);
        visited.add(e2.id);
      }
    }

    if (group.length >= 2) {
      const avgLat = Number(
        (group.reduce((acc, curr) => acc + curr.lat, 0) / group.length).toFixed(4),
      );
      const avgLon = Number(
        (group.reduce((acc, curr) => acc + curr.lon, 0) / group.length).toFixed(4),
      );
      const convergenceScore = Number((group.length * 1.5 + radiusKm / 100).toFixed(2));

      clusters.push({
        id: `focal-${i + 1}-${Math.round(avgLat)}_${Math.round(avgLon)}`,
        centerLat: avgLat,
        centerLon: avgLon,
        eventCount: group.length,
        regionName: `Coordinates (${avgLat.toFixed(2)}°, ${avgLon.toFixed(2)}°)`,
        events: group,
        convergenceScore,
      });
    }
  }

  return clusters.sort((a, b) => b.convergenceScore - a.convergenceScore);
}
