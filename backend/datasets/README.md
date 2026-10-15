# Datasets

Real data used by the Earth Intelligence Platform, exported for the demo places in `places.csv`.
Regenerate with `node scripts/export-datasets.js`. Retrieved: 2026-10-15T13:50:44.483Z.

The live app queries the same sources on demand for any place on Earth; these files are snapshots.

| File | Rows | Source | Licence / terms |
|---|---|---|---|
| `hydrorivers_reaches_demo.csv` | 377 | HydroRIVERS v1.0 (HydroSHEDS): river reaches within 50 km (catchment >= 1000 km2; >= 100 km2 in the India region). The full network (998,251 reaches: 905,279 worldwide + 92,972 extra in the India region) is in `data/hydrorivers.bin` + `data/hydrorivers_geom.bin`, built by `scripts/build-rivers.py`. India soil grid: `data/soil_india.bin` (`scripts/build-soil-india.py`). | HydroSHEDS licence, attribution required |
| `tree_cover_loss_demo.csv` | 72 | Tree cover loss 2021-2024, natural forest, 10 km box (UMD / Hansen et al., via Global Nature Watch analytics API) | CC BY 4.0 |
| `river_discharge_glofas_demo.csv` | 6660 | GloFAS v4 daily river discharge (Copernicus Emergency Management Service) via Open-Meteo Flood API | CC BY 4.0 |
| `earthquakes_usgs_demo.csv` | 59 | USGS ComCat earthquakes M5+ within 150 km since 1970 | Public domain |

Also used live (not exported): ISRIC SoilGrids 2.0 (CC BY 4.0), AWS Terrain Tiles (various open DEMs),
Esri World Imagery (attribution required), Open-Meteo weather (CC BY 4.0).

## Citations
- Lehner, B., Grill, G. (2013). Global river hydrography and network routing: baseline data and new approaches to study the world's large river systems. *Hydrological Processes*, 27(15), 2171-2186.
- Hansen, M. C. et al. (2013). High-resolution global maps of 21st-century forest cover change. *Science*, 342(6160), 850-853.
- Harrigan, S. et al. (2020). GloFAS-ERA5 operational global river discharge reanalysis 1979-present. *Earth System Science Data*, 12, 2043-2060.
- Poggio, L. et al. (2021). SoilGrids 2.0: producing soil information for the globe with quantified spatial uncertainty. *SOIL*, 7, 217-240.
