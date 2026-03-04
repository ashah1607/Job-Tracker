export default async function handler(req, res) {
  try {
    const url = req.query.url;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Missing url" });
    }

    // Basic safety: only allow http(s)
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "Invalid url" });
    }

    const r = await fetch(url, {
      headers: {
        // Helps with some sites that block unknown agents
        "User-Agent":
          "Mozilla/5.0 (compatible; DelusionDashboard/1.0; +https://vercel.app)",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!r.ok) {
      return res.status(400).json({ error: `Fetch failed (${r.status})` });
    }

    const html = await r.text();

    // Helpers
    const pickFirst = (...vals) => vals.find(v => v && String(v).trim()) || "";

    // 1) Try JSON-LD JobPosting
    let job = {};
    const ldScripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
      .map(m => m[1])
      .slice(0, 10);

    for (const raw of ldScripts) {
      try {
        const parsed = JSON.parse(raw.trim());
        const candidates = Array.isArray(parsed) ? parsed : [parsed];

        const jobPosting = candidates.find(
          x => x && (x["@type"] === "JobPosting" || (Array.isArray(x["@type"]) && x["@type"].includes("JobPosting")))
        );
        if (jobPosting) {
          job = jobPosting;
          break;
        }
      } catch {}
    }

    // Extract fields from JSON-LD when present
    let title = "";
    let company = "";
    let location = "";
    let salary = "";
    let workStyle = "";

    if (job && Object.keys(job).length) {
      title = pickFirst(job.title, job.name);

      // hiringOrganization can be object or string
      if (job.hiringOrganization) {
        company = pickFirst(
          job.hiringOrganization.name,
          typeof job.hiringOrganization === "string" ? job.hiringOrganization : ""
        );
      }

      // Location
      // jobLocation can be array/object
      const jl = job.jobLocation;
      const locObj = Array.isArray(jl) ? jl[0] : jl;
      const addr = locObj?.address || locObj?.jobLocation?.address || null;

      if (addr) {
        const city = pickFirst(addr.addressLocality, addr.addressRegion);
        const region = pickFirst(addr.addressRegion);
        const country = pickFirst(addr.addressCountry);
        location = [city, region].filter(Boolean).join(", ");
        if (!location && country) location = country;
      }

      // Remote / work style
      const locType = pickFirst(job.jobLocationType, job.employmentType);
      const remoteHints = JSON.stringify(job).toLowerCase();
      if (remoteHints.includes("remote")) workStyle = "Remote";
      if (!workStyle && remoteHints.includes("hybrid")) workStyle = "Hybrid";
      if (!workStyle && locType) {
        if (String(locType).toLowerCase().includes("remote")) workStyle = "Remote";
      }

      // Salary (baseSalary may be object)
      const bs = job.baseSalary;
      if (bs) {
        const val = bs.value;
        const currency = pickFirst(bs.currency, val?.currency);
        const unit = pickFirst(val?.unitText, bs.unitText);
        const amount = pickFirst(val?.value, val?.minValue, bs.value);
        const max = pickFirst(val?.maxValue);
        if (amount && max) salary = `${currency ? currency + " " : ""}${amount}–${max}${unit ? " / " + unit : ""}`;
        else if (amount) salary = `${currency ? currency + " " : ""}${amount}${unit ? " / " + unit : ""}`;
      }
    }

    // 2) Fallback to <title> / og:title if JSON-LD not found
    if (!title) {
      const ogTitle = (html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || [])[1];
      const docTitle = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
      title = pickFirst(ogTitle, docTitle);
    }

    // 3) Fallback company via og:site_name
    if (!company) {
      const ogSite = (html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i) || [])[1];
      company = pickFirst(ogSite);
    }

    // 4) If still no workStyle, infer from title/html text
    const lower = html.toLowerCase();
    const titleLower = String(title).toLowerCase();
    if (!workStyle) {
      if (titleLower.includes("remote") || lower.includes(" work from home")) workStyle = "Remote";
      else if (titleLower.includes("hybrid") || lower.includes("hybrid")) workStyle = "Hybrid";
      else workStyle = "On-site";
    }

    return res.status(200).json({
      title: title || "",
      company: company || "",
      location: location || "",
      salary: salary || "",
      workStyle: workStyle || "",
    });
  } catch (e) {
    return res.status(500).json({ error: "Unexpected error" });
  }
}
