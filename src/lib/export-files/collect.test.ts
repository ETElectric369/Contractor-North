import { describe, it, expect } from "vitest";
import {
  COMPANY_FOLDERS,
  FILES_CAP_BYTES,
  FILES_CAP_COUNT,
  capturePhotoPaths,
  companyFileRefs,
  entrySegment,
  inspectionAnswerPaths,
  isOwnPath,
  jobFileRefs,
  knownBytes,
  nameFromKey,
  nameWithExtension,
  overCap,
  uniqueNames,
  type FileRef,
} from "./collect";

/**
 * WHICH FILES GO IN A ZIP (cn-v1138): one ref per object however many rows point at it, named by
 * the documents row when there is one and by the key otherwise, a repeat suffixed, a stranger's key
 * left out, the cap judged on known sizes only, and the company zip's folders by the pointer's
 * table. Every name and street here is invented.
 */
const ORG = "org-1";
const JOB = "11111111-1111-4111-8111-111111111111";
const inJob = (file: string) => `${ORG}/${JOB}/${file}`;

describe("a pointer is a key under the company's own prefix", () => {
  it("accepts the company's keys and refuses URLs, another company's keys, '..' and empty segments", () => {
    expect(isOwnPath(ORG, inJob("1727000000000-panel.jpg"))).toBe(true);
    expect(isOwnPath(ORG, " org-1/insurance/policy.pdf ")).toBe(true);
    expect(isOwnPath(ORG, "https://x.supabase.co/storage/v1/object/documents/org-1/a.jpg")).toBe(false);
    expect(isOwnPath(ORG, "org-2/insurance/policy.pdf")).toBe(false);
    expect(isOwnPath(ORG, "org-1/../org-2/a.jpg")).toBe(false);
    expect(isOwnPath(ORG, "org-1//a.jpg")).toBe(false);
    expect(isOwnPath(ORG, "org-1/")).toBe(false);
    expect(isOwnPath(ORG, "/org-1/a.jpg")).toBe(false);
    expect(isOwnPath(ORG, null)).toBe(false);
    expect(isOwnPath(ORG, 12)).toBe(false);
  });

  it("a visit's photos come as keys or as {path}; anything else is skipped", () => {
    expect(capturePhotoPaths({ photos: ["org-1/appointments/a1/1-x.jpg", { path: "org-1/appointments/a1/2-y.jpg" }, "", null, 7, {}] })).toEqual([
      "org-1/appointments/a1/1-x.jpg",
      "org-1/appointments/a1/2-y.jpg",
    ]);
    expect(capturePhotoPaths(null)).toEqual([]);
    expect(capturePhotoPaths({ photos: "nope" })).toEqual([]);
  });

  it("an inspection sheet's files: a file slot's keys (a list, a bare key, {path}, {paths}) under the company's prefix; words, numbers, a task's object, a stranger's key and a repeat are not files", () => {
    const answers = {
      plans: ["org-1/appointments/a1/1-plan.pdf", " org-1/appointments/a1/2-plan.pdf ", "org-2/appointments/a1/3-theirs.pdf", "", 7],
      panel_photo: "org-1/appointments/a1/4-panel.jpg",
      old_shape: { path: "org-1/appointments/a1/5-old.jpg" },
      older_shape: { paths: ["org-1/appointments/a1/6-older.jpg", { path: "org-1/appointments/a1/7-oldest.jpg" }] },
      conduit: "3/4 EMT",
      climb: "org-1/../org-2/appointments/a1/x.jpg",
      count: 2,
      done: true,
      nothing: null,
      task: { id: "t1", name: "Hang the fixture", materials: [{ description: "1/2 EMT", qty: 3 }] },
      again: ["org-1/appointments/a1/1-plan.pdf"],
    };
    expect(inspectionAnswerPaths("org-1", answers)).toEqual([
      "org-1/appointments/a1/1-plan.pdf",
      "org-1/appointments/a1/2-plan.pdf",
      "org-1/appointments/a1/4-panel.jpg",
      "org-1/appointments/a1/5-old.jpg",
      "org-1/appointments/a1/6-older.jpg",
      "org-1/appointments/a1/7-oldest.jpg",
    ]);
    // "org-1/not a key" IS under the prefix with two segments: a key is a key; the walk and the pack
    // decide whether the object exists. A climb never is.
    expect(inspectionAnswerPaths("org-1", { note: "org-1/not a key" })).toEqual(["org-1/not a key"]);
    expect(inspectionAnswerPaths("org-1", null)).toEqual([]);
    expect(inspectionAnswerPaths("org-1", "org-1/appointments/a1/1.jpg")).toEqual([]);
    expect(inspectionAnswerPaths("org-1", ["org-1/appointments/a1/1.jpg"])).toEqual([]);
    expect(inspectionAnswerPaths("org-1", {})).toEqual([]);
  });
});

describe("naming", () => {
  it("a key's last segment with the upload stamp off; a typed name gets the key's extension when it has none; slashes never make folders", () => {
    expect(nameFromKey(inJob("1727000000000-panel.jpg"))).toBe("panel.jpg");
    expect(nameFromKey("org-1/branding/logo-1727000000000.png")).toBe("logo-1727000000000.png");
    expect(nameFromKey(inJob("1727000000000-"))).toBe("1727000000000-");
    expect(nameWithExtension("Driver license", "org-1/employees/p1/1727000000000-scan.pdf")).toBe("Driver license.pdf");
    expect(nameWithExtension("Driver license.PDF", "org-1/employees/p1/1727000000000-scan.pdf")).toBe("Driver license.PDF");
    expect(nameWithExtension("a/b\\c", inJob("1-x.jpg"))).toBe("a-b-c.jpg");
    expect(nameWithExtension("   ", inJob("1727000000000-x.jpg"))).toBe("x.jpg");
    expect(nameWithExtension("..secret", inJob("1-x.jpg"))).toBe("secret.jpg");
  });

  it("the characters Windows refuses in a file name (< > : \" | ? *) are taken out of a typed name; the key's name is the fallback", () => {
    expect(entrySegment('Panel: "before" <2>? *|x', inJob("1-x.jpg"))).toBe("Panel before 2 x");
    expect(nameWithExtension("Receipt 10/28: CED?", inJob("1727000000000-rcpt.pdf"))).toBe("Receipt 10-28 CED.pdf");
    expect(entrySegment("<>:\"|?*", inJob("1727000000000-plans.pdf"))).toBe("plans.pdf");
  });

  it("a repeat is suffixed before its extension, case-insensitively, and inside its folder", () => {
    const named = uniqueNames([
      { name: "panel.jpg" },
      { name: "Panel.jpg" },
      { name: "panel (2).jpg" },
      { name: "panel.jpg" },
      { name: "Insurance/policy" },
      { name: "Insurance/policy" },
      { name: "Insurance/policy" },
    ]).map((r) => r.name);
    // The third is "panel (2).jpg" as uploaded, already taken by the second's suffix: it goes to (3), never "(2) (2)".
    expect(named).toEqual(["panel.jpg", "Panel (2).jpg", "panel (3).jpg", "panel (4).jpg", "Insurance/policy", "Insurance/policy (2)", "Insurance/policy (3)"]);
  });
});

describe("jobFileRefs", () => {
  it("one ref per object: the documents row names it, the listing sizes it, the task and the visit pointing at the same key add nothing", () => {
    const refs = jobFileRefs({
      orgId: ORG,
      jobId: JOB,
      documents: [{ name: "Panel before", file_url: inJob("1727000000000-img1.jpg"), size_bytes: null }],
      picks: [{ file_path: `${ORG}/picks/${JOB}/swatch.png` }],
      tasks: [{ photo_path: inJob("1727000000000-img1.jpg"), done_photo_path: inJob("1727000000001-img2.jpg") }],
      appointments: [{ capture: { photos: [`${ORG}/appointments/a1/1727000000002-visit.jpg`, inJob("1727000000000-img1.jpg")] } }],
      listing: [
        { path: inJob("1727000000000-img1.jpg"), size: 1200 },
        { path: inJob("1727000000003-plans.pdf"), size: 5000 },
      ],
    });
    expect(refs).toEqual([
      { bucket: "documents", path: inJob("1727000000000-img1.jpg"), name: "Panel before.jpg", size: 1200 },
      { bucket: "documents", path: inJob("1727000000003-plans.pdf"), name: "plans.pdf", size: 5000 },
      { bucket: "documents", path: inJob("1727000000001-img2.jpg"), name: "img2.jpg", size: null },
      { bucket: "documents", path: `${ORG}/appointments/a1/1727000000002-visit.jpg`, name: "visit.jpg", size: null },
      { bucket: "documents", path: `${ORG}/picks/${JOB}/swatch.png`, name: "swatch.png", size: null },
    ]);
  });

  it("a visit's sheet files and its folder's files are in, named by the key, sized by the walk; a stranger's folder entry is not", () => {
    const refs = jobFileRefs({
      orgId: ORG,
      jobId: JOB,
      documents: [],
      picks: [],
      tasks: [],
      appointments: [
        {
          capture: { photos: [`${ORG}/appointments/a1/1727000000002-visit.jpg`] },
          inspection_answers: { plans: [`${ORG}/appointments/a1/1727000000004-site-plan.pdf`], conduit: "3/4 EMT" },
        },
      ],
      listing: [],
      visits: [
        { path: `${ORG}/appointments/a1/1727000000002-visit.jpg`, size: 500 },
        { path: `${ORG}/appointments/a1/1727000000004-site-plan.pdf`, size: 9000 },
        { path: `${ORG}/appointments/a1/1727000000005-meter.jpg`, size: 400 },
        { path: `org-2/appointments/a1/1-theirs.jpg`, size: 1 },
      ],
    });
    expect(refs).toEqual([
      { bucket: "documents", path: `${ORG}/appointments/a1/1727000000002-visit.jpg`, name: "visit.jpg", size: 500 },
      { bucket: "documents", path: `${ORG}/appointments/a1/1727000000004-site-plan.pdf`, name: "site-plan.pdf", size: 9000 },
      { bucket: "documents", path: `${ORG}/appointments/a1/1727000000005-meter.jpg`, name: "meter.jpg", size: 400 },
    ]);
  });

  it("two files uploaded under one name are both kept, the second suffixed; a row's own size is used when the listing has none", () => {
    const refs = jobFileRefs({
      orgId: ORG,
      jobId: JOB,
      documents: [
        { name: "receipt.jpg", file_url: inJob("1-a.jpg"), size_bytes: 10 },
        { name: "receipt.jpg", file_url: inJob("2-b.jpg"), size_bytes: 20 },
      ],
      picks: [],
      tasks: [],
      appointments: [],
      listing: [],
    });
    expect(refs.map((r) => [r.name, r.size])).toEqual([
      ["receipt.jpg", 10],
      ["receipt (2).jpg", 20],
    ]);
  });

  it("a stranger's key, a URL and a '..' never make it in, whichever table said them", () => {
    const refs = jobFileRefs({
      orgId: ORG,
      jobId: JOB,
      documents: [{ name: "x", file_url: "https://cdn.example/x.jpg" }, { name: "y", file_url: `org-2/${JOB}/1-y.jpg` }],
      picks: [{ file_path: "org-1/../org-2/picks/x.png" }, { file_path: null }],
      tasks: [{ photo_path: "org-2/a/b.jpg", done_photo_path: null }],
      appointments: [{ capture: { photos: ["org-2/appointments/a/1.jpg"] } }, { capture: null }],
      listing: [{ path: "org-2/stray.jpg", size: 1 }],
    });
    expect(refs).toEqual([]);
  });
});

describe("the cap", () => {
  const ref = (size: number | null, i: number): FileRef => ({ bucket: "documents", path: `org-1/j/${i}.jpg`, name: `${i}.jpg`, size });

  it("is judged on KNOWN sizes only: unknown sizes count nothing, a negative or NaN counts nothing", () => {
    expect(knownBytes([ref(100, 1), ref(null, 2), ref(-5, 3), ref(Number.NaN, 4)])).toBe(100);
    expect(overCap([ref(FILES_CAP_BYTES, 1), ref(null, 2)])).toBe(false);
    expect(overCap([ref(FILES_CAP_BYTES, 1), ref(1, 2)])).toBe(true);
    expect(overCap(Array.from({ length: 1000 }, (_, i) => ref(null, i)))).toBe(false);
  });

  it("more entries than one zip can hold is over the cap too", () => {
    expect(FILES_CAP_COUNT).toBe(65_535);
    const many = Array.from({ length: FILES_CAP_COUNT + 1 }, (_, i) => ref(null, i));
    expect(overCap(many)).toBe(true);
    expect(overCap(many.slice(1))).toBe(false);
    expect(FILES_CAP_BYTES).toBe(400 * 1024 * 1024);
  });
});

describe("companyFileRefs: the folder follows the pointer", () => {
  it("employees by person, insurance, what Organize My filed by its title, intake, the visits (one folder each), branding (avatars apart), lead uploads", () => {
    expect(COMPANY_FOLDERS.visits).toBe("Visits");
    const refs = companyFileRefs({
      orgId: ORG,
      employeeDocs: [
        { profile_id: "p1", name: "Driver License", file_url: `${ORG}/employees/p1/1727000000000-scan.pdf` },
        { profile_id: "p9", name: "Cert", file_url: `${ORG}/employees/p9/1727000000000-cert.pdf` },
        { profile_id: "p1", name: "Elsewhere", file_url: "org-2/employees/p1/1-x.pdf" },
      ],
      people: [
        { id: "p1", full_name: "Thistlewood Catbird" },
        { id: "p2", full_name: "" },
      ],
      organized: [{ title: "Bayberry Supply receipt", file_url: `${ORG}/organize/1727000000000-IMG_1.jpg` }],
      listings: {
        employees: [
          { path: `${ORG}/employees/p1/1727000000000-scan.pdf`, size: 300 },
          { path: `${ORG}/employees/p2/1727000000001-w4.pdf`, size: 400 },
        ],
        insurance: [{ path: `${ORG}/insurance/1727000000000-policy.pdf`, size: 500 }],
        organize: [{ path: `${ORG}/organize/1727000000000-IMG_1.jpg`, size: 600 }, { path: `${ORG}/organize/1727000000001-IMG_2.jpg`, size: 700 }],
        intake: [{ path: `${ORG}/intake/plans.pdf`, size: 800 }],
        appointments: [
          { path: `${ORG}/appointments/a1/1727000000002-visit.jpg`, size: 900 },
          { path: `${ORG}/appointments/a2/1727000000004-site-plan.pdf`, size: 1000 },
          { path: `${ORG}/appointments/stray.jpg`, size: 1100 },
          { path: `org-2/appointments/a1/1-theirs.jpg`, size: 1 },
        ],
        branding: [
          { path: `${ORG}/logo-1727000000000.png`, size: 10 },
          { path: `${ORG}/portfolio-1727000000000-0.jpg`, size: 20 },
          { path: `${ORG}/avatars/u1-1727000000000.jpg`, size: 30 },
        ],
        leads: [{ path: `${ORG}/1727000000000-9b2c.jpg`, size: 40 }],
      },
    });
    expect(refs.map((r) => [r.bucket, r.name, r.size])).toEqual([
      ["documents", "Employees/Thistlewood Catbird/Driver License.pdf", 300],
      ["documents", "Employees/p9/Cert.pdf", null],
      ["documents", "Employees/p2/w4.pdf", 400],
      ["documents", "Insurance/policy.pdf", 500],
      ["documents", "Organized/Bayberry Supply receipt.jpg", 600],
      ["documents", "Organized/IMG_2.jpg", 700],
      ["intake-uploads", "Intake/plans.pdf", 800],
      ["documents", "Visits/a1/visit.jpg", 900],
      ["documents", "Visits/a2/site-plan.pdf", 1000],
      ["documents", "Visits/stray.jpg", 1100],
      ["branding", "Branding/logo-1727000000000.png", 10],
      ["branding", "Branding/portfolio-1727000000000-0.jpg", 20],
      ["branding", "Branding/Avatars/u1-1727000000000.jpg", 30],
      ["lead-uploads", "Lead Uploads/9b2c.jpg", 40],
    ]);
  });

  it("a long profile id with no roster name is a short folder, never a 36-character one", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const refs = companyFileRefs({
      orgId: ORG,
      employeeDocs: [],
      people: [],
      organized: [],
      listings: { employees: [{ path: `${ORG}/employees/${id}/1727000000000-a.pdf`, size: 1 }], insurance: [], organize: [], intake: [], appointments: [], branding: [], leads: [] },
    });
    expect(refs.map((r) => r.name)).toEqual(["Employees/22222222/a.pdf"]);
  });

  it("nothing at all is nothing", () => {
    expect(
      companyFileRefs({ orgId: ORG, employeeDocs: [], people: [], organized: [], listings: { employees: [], insurance: [], organize: [], intake: [], appointments: [], branding: [], leads: [] } }),
    ).toEqual([]);
  });
});
