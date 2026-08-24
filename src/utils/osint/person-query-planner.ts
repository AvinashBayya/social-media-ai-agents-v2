/**
 * Person Query Planner — generates targeted public search and Google Dork
 * queries based on supplied PersonTarget parameters (name, city, org, designation, etc.).
 *
 * Adheres strictly to Sentinel safety & authorization guidelines:
 * - Public search/dork expressions only (no private/leaked database queries).
 * - Exact-match expressions for name + location, name + organization, etc.
 */

import type { PersonInvestigationSeeds } from "./person-investigation";

export interface PersonSearchQuery {
  title: string;
  query: string;
  category: "general" | "organization" | "location" | "documents" | "domain";
}

/**
 * Generates targeted public query expressions based on available target fields.
 */
export function generatePersonSearchQueries(seeds: PersonInvestigationSeeds): PersonSearchQuery[] {
  const name = seeds.personName.trim();
  if (!name) return [];

  const queries: PersonSearchQuery[] = [];
  const cleanName = `"${name}"`;

  // 1. Basic Name Query
  queries.push({
    title: "Full Name Search",
    query: cleanName,
    category: "general",
  });

  // 2. Name + City / Location
  const location = [seeds.city, seeds.state, seeds.country].filter(Boolean).map((s) => s!.trim()).join(" ");
  if (location) {
    queries.push({
      title: "Name + Location",
      query: `${cleanName} "${location}"`,
      category: "location",
    });
  }

  // 3. Name + Organization
  if (seeds.organization?.trim()) {
    const org = seeds.organization.trim();
    queries.push({
      title: "Name + Organization",
      query: `${cleanName} "${org}"`,
      category: "organization",
    });

    if (location) {
      queries.push({
        title: "Name + Organization + Location",
        query: `${cleanName} "${org}" "${location}"`,
        category: "organization",
      });
    }
  }

  // 4. Name + Designation
  if (seeds.designation?.trim()) {
    const des = seeds.designation.trim();
    queries.push({
      title: "Name + Designation",
      query: `${cleanName} "${des}"`,
      category: "general",
    });

    if (seeds.organization?.trim()) {
      queries.push({
        title: "Name + Designation + Organization",
        query: `${cleanName} "${des}" "${seeds.organization.trim()}"`,
        category: "organization",
      });
    }
  }

  // 5. Public Documents (filetype:pdf, doc, etc.)
  queries.push({
    title: "Public PDF Documents",
    query: `${cleanName} filetype:pdf`,
    category: "documents",
  });

  // 6. Organization-specific Domain Search
  if (seeds.domain?.trim()) {
    const dom = seeds.domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (dom) {
      queries.push({
        title: "Domain Targeted Search",
        query: `site:${dom} ${cleanName}`,
        category: "domain",
      });
    }
  }

  return queries;
}
