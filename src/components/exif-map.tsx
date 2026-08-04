import { useEffect, useRef } from "react";
import type { GpsFix } from "@/utils/imaging";

/**
 * Leaflet map for an EXIF GPS fix.
 *
 * Renders only when a coordinate actually exists — there is no default view and
 * no placeholder marker. A map centred on 0,0 with a pin on it would read as a
 * location finding, and 0,0 is a real place in the Gulf of Guinea.
 *
 * Leaflet is imported dynamically because it touches `window` at module scope
 * and would break SSR.
 */
export function ExifMap({ gps, label }: { gps: GpsFix; label: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !containerRef.current) return;
    let cancelled = false;

    if (!document.querySelector('link[data-leaflet]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      link.setAttribute("data-leaflet", "true");
      document.head.appendChild(link);
    }

    import("leaflet").then((mod) => {
      if (cancelled || !containerRef.current) return;
      const L: any = (mod as any).default ?? mod;

      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }

      const map = L.map(containerRef.current, {
        center: [gps.latitude, gps.longitude],
        zoom: 15,
        attributionControl: true,
      });
      mapRef.current = map;

      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap, &copy; CARTO",
      }).addTo(map);

      L.marker([gps.latitude, gps.longitude])
        .addTo(map)
        .bindPopup(
          `<strong>${label}</strong><br/>${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}` +
            (gps.altitude !== null ? `<br/>${gps.altitude.toFixed(0)} m` : ""),
        );

      // Leaflet mis-measures its container when created inside a panel that is
      // still laying out.
      setTimeout(() => map.invalidateSize(), 0);
    });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [gps.latitude, gps.longitude, gps.altitude, label]);

  return (
    <div className="space-y-1.5">
      <div ref={containerRef} className="h-56 w-full rounded border border-[#263548]" />
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-[#94A3B8]">
        <span>
          {gps.latitude.toFixed(6)}, {gps.longitude.toFixed(6)}
          {gps.altitude !== null ? ` · ${gps.altitude.toFixed(0)} m` : ""}
        </span>
        <a
          href={`https://www.openstreetmap.org/?mlat=${gps.latitude}&mlon=${gps.longitude}#map=16/${gps.latitude}/${gps.longitude}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#3B82F6] hover:underline"
        >
          OpenStreetMap
        </a>
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${gps.latitude},${gps.longitude}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#3B82F6] hover:underline"
        >
          Google Maps
        </a>
      </div>
    </div>
  );
}
