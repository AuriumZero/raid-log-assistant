"""Builds the synthetic RAID log and meeting notes in public/samples/.

Everything here is invented: a fictional Data Platform team migrating to a
lakehouse. The notes are written to exercise each kind of change the assistant
proposes: new items, updates to existing items, closures, and lines that should
be ignored.

Run: python3 scripts/make_samples.py   (needs openpyxl)
"""
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

OUT = Path(__file__).resolve().parent.parent / "public" / "samples"

HEADERS = ["ID", "Type", "Title", "Description", "Owner", "Status", "Probability", "Impact",
           "Mitigation / action", "Date raised", "Last updated", "Due date"]

ITEMS = [
    ("R-001", "Risk", "Vendor feed contract renewal may lapse before the new loader is live",
     "The vendor contract ends 31 Oct. Without renewal the orders feed stops.", "Jordan Lee", "Open",
     "Medium", "High", "Escalate the renewal to Procurement.", date(2026, 8, 4), date(2026, 8, 20), date(2026, 10, 31)),
    ("R-002", "Risk", "Legacy and lakehouse sales figures may not reconcile before finance sign-off",
     "Finance must sign off the reconciliation before cutover.", "Priya Natarajan", "Open",
     "High", "High", "Daily reconciliation report; timezone handling under review.", date(2026, 8, 18), date(2026, 9, 22), date(2026, 10, 10)),
    ("R-003", "Risk", "Key data engineer on leave during cutover week",
     "Only one engineer knows the legacy export jobs well.", "Sam Okafor", "Open",
     "Low", "Medium", "Pair on the cutover runbook in advance.", date(2026, 8, 25), date(2026, 9, 1), None),
    ("A-001", "Assumption", "Finance will provide the cost-center list by end of September",
     "Needed to tag every job with a cost-center label.", "Mei Tanaka", "Open",
     "", "Medium", "", date(2026, 9, 2), date(2026, 9, 10), date(2026, 9, 30)),
    ("A-002", "Assumption", "Dashboard users can tolerate a 2-hour freshness window during migration",
     "Agreed informally with the BI leads.", "Alex Rivera", "Open",
     "", "Medium", "Confirm in writing with BI leads.", date(2026, 9, 8), date(2026, 9, 25), None),
    ("I-001", "Issue", "Orders feed partitions arrive late on Mondays",
     "Monday dashboards show partial orders until mid-morning.", "Priya Natarajan", "In progress",
     "", "Medium", "Late-partition alert and automatic backfill.", date(2026, 9, 1), date(2026, 9, 16), None),
    ("I-002", "Issue", "Oversized dev warehouse cluster is driving up cloud costs",
     "", "Sam Okafor", "Open", "", "Low", "Right-size the dev cluster.", date(2026, 9, 3), date(2026, 9, 15), None),
    ("D-001", "Dependency", "Security team approval of the new service accounts",
     "The lakehouse jobs can't run in production without the new accounts.", "Jordan Lee", "Open",
     "", "High", "Request submitted 12 Sep.", date(2026, 9, 12), date(2026, 9, 12), date(2026, 10, 15)),
]

WEEKLY = """Data Platform weekly status - 29 Sep 2026
Attendees: Alex, Priya, Sam, Jordan, Mei

Updates
- Marketing mart moved to Delta and the finance dashboards now point at the lakehouse views.
- Row-count differences between the legacy and lakehouse sales tables were traced to a timezone bug. The fix is in, but finance has not re-run the reconciliation yet, so sign-off could still slip past 10 Oct.
- Monday orders feed: the new late-partition alert fired twice this week and the backfill caught up both times. Priya considers the late-arriving partitions issue resolved.
- Dev cluster right-sizing is done, so the oversized dev warehouse issue can be closed.

Risks and blockers
- Risk: the service-visit history migration has carried over twice and might not finish before the cutover freeze on 20 Oct. Owner: Alex Rivera.
- Cost-center tagging is blocked waiting on Finance for the cost-center list. Mei to chase.
- We are assuming the clickstream proof of concept can reuse the existing Kafka cluster rather than needing a new one.
- Sam will be out 13-17 Oct, which is cutover week.

Actions
- Jordan to confirm with Procurement whether the vendor feed contract renewal has been signed.
"""

STEERING = """Steering committee - 30 Sep 2026

Decision: cutover date stays at 20 Oct.
Concern raised by Finance: if the sales reconciliation is not signed off by 10 Oct, the cutover date is at risk. This is a major risk for the program.
Data Platform depends on the Security team approving the new service accounts before cutover; approval is now expected 8 Oct.
Third-party schema changes have broken two loads this quarter and schema drift detection is not in place yet. Owner: Priya Natarajan.
Budget: no change.
"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    ws = wb.active
    ws.title = "RAID log"
    ws.append(HEADERS)
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="0F6E66")
    for item in ITEMS:
        ws.append(list(item))
    for row in ws.iter_rows(min_row=2):
        for c in row[9:12]:
            c.number_format = "mmm d, yyyy"
        for c in row:
            c.alignment = Alignment(vertical="top", wrap_text=True)
    for col, width in zip("ABCDEFGHIJKL", [8, 12, 48, 40, 16, 12, 11, 9, 36, 13, 13, 13]):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = "A2"
    wb.save(OUT / "raid-log.xlsx")
    (OUT / "weekly-status-2026-09-29.md").write_text(WEEKLY, encoding="utf-8")
    (OUT / "steering-committee-2026-09-30.txt").write_text(STEERING, encoding="utf-8")
    print("wrote", sorted(p.name for p in OUT.iterdir()))


if __name__ == "__main__":
    main()
