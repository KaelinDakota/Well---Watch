-- GOLD glossary: plain-language definitions the assistant can cite, so even "what does X mean?" answers have a source.
-- Written for this demo from general industry usage; a client would replace or extend it with their own definitions.
CREATE OR REPLACE TABLE workspace.well_ops.gold_glossary
COMMENT 'GOLD. Plain-language definitions of terms used in Well Watch (oil and gas terms and app concepts). Source column says where each comes from.'
AS SELECT * FROM VALUES
  ('bbl/d', 'Production', 'Barrels per day. One barrel is 159 litres. The main unit for oil and water rates.', 'Industry usage'),
  ('Type curve', 'Production', 'The production rate a well is expected to have at its age, from a decline model fitted to similar wells. Production below it means the well is underperforming.', 'Industry usage; Well Watch uses Arps decline parameters per well (silver_type_curves / gold_daily_well.target_oil_bopd)'),
  ('Water cut', 'Production', 'The share of produced liquid that is water: water / (oil + water). A sudden rise can mean water breakthrough or a frac hit from a nearby well.', 'Industry usage'),
  ('GOR (gas-oil ratio)', 'Production', 'Gas produced per barrel of oil, in standard cubic feet per barrel. A rising GOR can mean reservoir pressure is dropping below the bubble point or gas is coning.', 'Industry usage'),
  ('Downtime', 'Production', 'Time a well is not producing. Planned downtime (turnarounds, workovers) is expected; unplanned downtime (failures, power, weather) is lost production.', 'Industry usage'),
  ('ESP (electric submersible pump)', 'Production', 'An electric pump set deep in the well that lifts fluid to surface. Failures usually need a service rig to pull and replace the pump.', 'Industry usage'),
  ('Rod pump', 'Production', 'A pumpjack at surface moving a string of rods that drive a pump downhole. The most common artificial lift for oil wells.', 'Industry usage'),
  ('Workover', 'Production', 'Work done on an existing well to restore or improve production, usually with a service rig (pump change, cleanout, repair).', 'Industry usage'),
  ('LOE (lease operating expense)', 'Economics', 'The cost of running a well: power, chemicals, labour, repairs, trucking. Compared with netback to get operating margin.', 'Industry usage'),
  ('Netback', 'Economics', 'Revenue per barrel after royalties and transport. In Well Watch: price x (1 - royalty) - transport, from gold_price_assumptions.', 'Well Watch definition (gold_monthly_economics)'),
  ('Value at risk ($/day)', 'Well Watch', 'Dollars per day being lost on a well: oil below the type curve x oil netback, plus the daily operating loss on wells that cost more to run than they earn.', 'Well Watch definition (gold_well_snapshot, flags.js)'),
  ('Payback (days)', 'Well Watch', 'Estimated fix cost divided by $/day at risk: roughly how many days of recovered production pay for the fix.', 'Well Watch definition (flags.js)'),
  ('Points', 'Well Watch', 'Each flag rule has a weight. A well''s points are the sum of the weights of the rules it trips, with rules in the same group counted once. Points break ties within a tier.', 'Well Watch definition (flags.js)'),
  ('Tiers', 'Well Watch', 'The ranked list is split into Safety (most severe first), Production and cost (by $/day, payback or points), and Watch list. Wells marked as being handled are listed separately.', 'Well Watch definition (flags.js)'),
  ('Being handled', 'Well Watch', 'An engineer can mark a flag as being handled until a date. It leaves the top 10 and comes back when the date passes or the problem gets worse.', 'Well Watch definition (app_flag_acks)'),
  ('MAASP', 'Safety', 'Maximum allowable annular surface pressure: the highest pressure allowed at surface in a casing annulus, set from casing and wellhead ratings with a safety factor. Approaching it is an integrity warning.', 'Industry usage; per-well values in silver_well_safety.prod_casing_maasp_psi'),
  ('MAOP', 'Safety', 'Maximum allowable operating pressure of a pipeline or flowline. Operating near it risks a rupture or a relief valve lifting.', 'Industry usage; per-well values in silver_well_safety.flowline_maop_psi'),
  ('Casing / annulus pressure', 'Safety', 'Pressure in the space between strings of pipe in the well. Rising pressure can mean a tubing, packer or cement leak.', 'Industry usage'),
  ('Surface casing vent flow (SCVF)', 'Safety', 'Gas or fluid flowing out of the surface casing vent, a sign of a leak behind or between casing strings. In Alberta, flows are tested and classed as serious or non-serious; serious ones must be repaired.', 'Industry usage (Alberta practice)'),
  ('Gas migration', 'Safety', 'Gas moving up outside the well''s casing into soil or groundwater, often found with a soil gas test.', 'Industry usage'),
  ('Packer isolation test', 'Safety', 'A test confirming the packer seals the tubing from the casing annulus. A failure means pressure communication and an integrity problem.', 'Industry usage'),
  ('H2S (hydrogen sulfide)', 'Safety', 'A toxic, flammable gas in some produced gas. Dangerous at low concentrations. Wells producing it are called sour.', 'Industry usage'),
  ('Sour / critical sour', 'Safety', 'A sour well produces gas containing H2S. Critical sour wells have enough H2S that a release could affect the public, so they carry stricter requirements.', 'Industry usage'),
  ('EPZ (emergency planning zone)', 'Safety', 'The area around a sour well or facility where an H2S release could require emergency response, sized from the H2S release rate.', 'Industry usage (Alberta practice)'),
  ('ESD (emergency shutdown)', 'Safety', 'An automatic system that shuts a well or facility in when it detects an abnormal condition (high pressure, gas, fire). Repeated trips point to an underlying problem.', 'Industry usage'),
  ('PSV (pressure safety valve)', 'Safety', 'A valve that opens automatically to relieve pressure before equipment is overpressured. A lift means pressure reached the set point.', 'Industry usage'),
  ('SSSV (subsurface safety valve)', 'Safety', 'A valve in the tubing below surface that closes to shut in the well if surface equipment fails. Must be function-tested on a schedule.', 'Industry usage'),
  ('LDAR', 'Safety', 'Leak detection and repair: periodic surveys to find and fix fugitive gas leaks.', 'Industry usage'),
  ('Venting', 'Safety', 'Releasing gas to atmosphere instead of selling, conserving or flaring it. Regulators set limits on vented volumes.', 'Industry usage'),
  ('Reportable event', 'Safety', 'A spill, release or incident large or serious enough that it must be reported to the regulator within a set time.', 'Industry usage'),
  ('Medallion (bronze / silver / gold)', 'Data', 'Data layers in Databricks: bronze is raw data as received, silver is cleaned, gold is shaped for use. Well Watch reads gold and can trace any number back through silver and bronze to the raw file.', 'Well Watch architecture')
  AS t(term, topic, definition, source)
