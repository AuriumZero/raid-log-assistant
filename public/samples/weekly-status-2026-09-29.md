Data Platform weekly status - 29 Sep 2026
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
