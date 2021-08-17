
const fs = require('fs');

const libCoverage = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');
const SourceMaps = require('nyc/lib/source-maps');

async function getSummary(fileName) {
  const cov = JSON.parse(fs.readFileSync(fileName).toString());
  const map = libCoverage.createCoverageMap(cov);

  const sourceMaps = new SourceMaps({
    cache: false
  });
  map.data = await sourceMaps.remapCoverage(map.data);

  // create a context for report generation
  const context = libReport.createContext({
    dir: '.',
    coverageMap: map,
  });

  // create an instance of the relevant report class, passing the
  // report name e.g. json/html/html-spa/text
  // replace json-summary with path to custom reporter
  const report = reports.create('json-summary', {
    skipEmpty: false,
    skipFull: false,
    projectRoot: '.',
  });

  // call execute to synchronously create and write the report to disk
  report.execute(context);
  return JSON.parse(fs.readFileSync(report.file));
}

module.exports = getSummary;
