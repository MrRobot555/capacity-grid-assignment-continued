# Decisions

Yours to write, not your AI's. Short is good — bullets are fine, and half a page is
plenty. We read this first.

## What did the spec not tell you?

There are things this brief doesn't specify. Which ones did you hit, what did you decide,
and why?

- Whether weekends count. A lot of assignments end on a Saturday or Sunday. I only count Mon-Fri, because then Ana's week comes out at exactly 40 of 40, and thats clearly what the data was built for. Counting every day would put her at 56 and make loads of people look over when they aren't.
- What a "week" is. I used Monday to Sunday and keyed each week by its Monday date instead of the week number, because the default range crosses new year and week numbers get confusing there.
- Exactly at capacity isn't "over", only above it is. 0 capacity with any hours is over.
- How the grid stays right after a save. Spent the most time on this one. What it does: after you hit save the grid doesn't change until the server says ok, then it takes the value from the response and that's it, no reload. That works because capacity is one number per person and everything else (colours, the over counts, the filter) gets calcualted from it on render. I thought about optimistic updates but if the save fails the manager sees someone go green and then jump back to red, and your making decisions off those colours so I didn't like that. Saves are fast anyway. Refetching the whole range after every save would work too but felt like overkill here. (If capacity ever becomes per week, that's when I'd switch to refetching.)
- Failed save: grid stays as it was, what you typed stays in the box, error shows right there with a Retry. One thing I added later: if there's no response at all it says it "couldn't confirm" rather than "not saved", since the server might have saved it before the connection died. Retrying is fine either way, it just sets the value again.
- There's no history for capacity, so changing it changes past weeks too. The editor warns about that.
- Default range is this week plus the next 7. It's in the URL.

## What did you notice that looked wrong?

Anything in the output that didn't match what you expected. Whether you fixed it or left
it, we want to know you saw it.

- The assignments look duplicated, 15 rows each. They're not duplicates, they add up to normal hours per day, so I sum them.
- Every third week is pretty much empty, next week included. Checked it, and that's just how the seed was genrated. Left it.
- Öztürk was sorted after Yilmaz. That's Alpine Postgres sorting by bytes, so sorting happens in the browser now.
- Nothing in the DB stops negative capacity or an end date before the start date, so the API checks input and the the query can't go below 0.
- The query was much slower than it should have been. It turned out to be Postgres JIT kicking in. Passing the weeks in as an array fixed it.
- Lots of part-timers are booked full days, so many people show as over. I think that's intended.

## What did the AI get wrong that you caught?

One concrete example. Every real session has one.

It looked at hours_per_day (0.125, 0.25, 0.5 ...) and decided it was a fraction of a day. It's not, when I grouped the rows there were always 15 per assignment adding up to whole hours. Would've been easy to miss too, the wrong numbers still looked believable.

There was another one where its "fix" for bad dates made the 2-year query about 8x slower. I only noticed because I timed it again.

## What would you do differently with a week?

- Capacity with history (valid from a date), so edits can start from a given week. That would also cover holidays.
- Paging and filtering on the server for big teams.
- A proper date range index. Couldn't add one, the schema is fixed.
- Two managers editing the same person: right now the last save wins without any warning.
- Some caching so going back a week is instant.
- Get the browser tests runing in CI.
