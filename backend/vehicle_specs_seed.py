"""Seed data for South African vehicle specifications.

Mock of the Disk Drive vehicle specification API. Replace this file with a
real import job once the Disk Drive credentials are supplied.

Each row is one unique {make, fuel_type, year_of_production, transmission,
model, derivative} combination. The submit form's progressive-filter API
queries distinct values on this collection.
"""
from __future__ import annotations

FUEL_TYPES = ["Petrol", "Diesel", "Hybrid", "Electric"]
TRANSMISSIONS = ["Manual", "Automatic", "CVT", "DSG"]

# Compact seed covering the most-priced makes in the SA used-car market.
# id will be generated on insert (uuid). "year" is the year_of_production.
SEED_SPECS: list[dict] = [
    # ---- Toyota ----
    {"make": "Toyota", "model": "Corolla", "derivative": "1.6 Xs", "fuel": "Petrol", "trans": "Manual", "years": [2018, 2019, 2020, 2021, 2022, 2023]},
    {"make": "Toyota", "model": "Corolla", "derivative": "1.8 XR CVT", "fuel": "Petrol", "trans": "CVT", "years": [2020, 2021, 2022, 2023, 2024]},
    {"make": "Toyota", "model": "Corolla Cross", "derivative": "1.8 XR", "fuel": "Petrol", "trans": "CVT", "years": [2021, 2022, 2023, 2024]},
    {"make": "Toyota", "model": "Hilux", "derivative": "2.4 GD-6 SR 4x2", "fuel": "Diesel", "trans": "Manual", "years": [2019, 2020, 2021, 2022, 2023, 2024]},
    {"make": "Toyota", "model": "Hilux", "derivative": "2.8 GD-6 Raider 4x4 AT", "fuel": "Diesel", "trans": "Automatic", "years": [2020, 2021, 2022, 2023, 2024]},
    {"make": "Toyota", "model": "Fortuner", "derivative": "2.8 GD-6 4x4 AT", "fuel": "Diesel", "trans": "Automatic", "years": [2019, 2020, 2021, 2022, 2023, 2024]},
    {"make": "Toyota", "model": "RAV4", "derivative": "2.0 GX-R CVT", "fuel": "Petrol", "trans": "CVT", "years": [2019, 2020, 2021, 2022, 2023]},
    {"make": "Toyota", "model": "RAV4", "derivative": "2.5 Hybrid GX-R", "fuel": "Hybrid", "trans": "CVT", "years": [2020, 2021, 2022, 2023, 2024]},

    # ---- Volkswagen ----
    {"make": "Volkswagen", "model": "Polo", "derivative": "1.0 TSI Comfortline", "fuel": "Petrol", "trans": "Manual", "years": [2018, 2019, 2020, 2021, 2022, 2023]},
    {"make": "Volkswagen", "model": "Polo", "derivative": "1.0 TSI Highline DSG", "fuel": "Petrol", "trans": "DSG", "years": [2019, 2020, 2021, 2022, 2023, 2024]},
    {"make": "Volkswagen", "model": "Polo Vivo", "derivative": "1.4 Trendline", "fuel": "Petrol", "trans": "Manual", "years": [2018, 2019, 2020, 2021, 2022, 2023, 2024]},
    {"make": "Volkswagen", "model": "Golf", "derivative": "1.4 TSI Comfortline DSG", "fuel": "Petrol", "trans": "DSG", "years": [2018, 2019, 2020, 2021, 2022]},
    {"make": "Volkswagen", "model": "Golf", "derivative": "2.0 GTI DSG", "fuel": "Petrol", "trans": "DSG", "years": [2019, 2020, 2021, 2022, 2023, 2024]},
    {"make": "Volkswagen", "model": "Amarok", "derivative": "3.0 TDI V6 Highline 4Motion", "fuel": "Diesel", "trans": "Automatic", "years": [2019, 2020, 2021, 2022, 2023]},
    {"make": "Volkswagen", "model": "T-Cross", "derivative": "1.0 TSI Comfortline", "fuel": "Petrol", "trans": "Manual", "years": [2020, 2021, 2022, 2023, 2024]},

    # ---- Ford ----
    {"make": "Ford", "model": "Ranger", "derivative": "2.0 Bi-Turbo Wildtrak 4x4", "fuel": "Diesel", "trans": "Automatic", "years": [2019, 2020, 2021, 2022, 2023, 2024]},
    {"make": "Ford", "model": "Ranger", "derivative": "3.0 V6 Raptor 4x4", "fuel": "Diesel", "trans": "Automatic", "years": [2023, 2024]},
    {"make": "Ford", "model": "Everest", "derivative": "3.0 V6 Sport 4WD", "fuel": "Diesel", "trans": "Automatic", "years": [2023, 2024]},
    {"make": "Ford", "model": "Figo", "derivative": "1.5 Titanium", "fuel": "Petrol", "trans": "Manual", "years": [2018, 2019, 2020, 2021, 2022]},

    # ---- BMW ----
    {"make": "BMW", "model": "1 Series", "derivative": "118i M Sport", "fuel": "Petrol", "trans": "Automatic", "years": [2019, 2020, 2021, 2022, 2023]},
    {"make": "BMW", "model": "3 Series", "derivative": "320i M Sport", "fuel": "Petrol", "trans": "Automatic", "years": [2019, 2020, 2021, 2022, 2023, 2024]},
    {"make": "BMW", "model": "3 Series", "derivative": "330d M Sport", "fuel": "Diesel", "trans": "Automatic", "years": [2019, 2020, 2021, 2022]},
    {"make": "BMW", "model": "X3", "derivative": "xDrive20d M Sport", "fuel": "Diesel", "trans": "Automatic", "years": [2019, 2020, 2021, 2022, 2023]},
    {"make": "BMW", "model": "X5", "derivative": "xDrive30d M Sport", "fuel": "Diesel", "trans": "Automatic", "years": [2020, 2021, 2022, 2023, 2024]},

    # ---- Mercedes-Benz ----
    {"make": "Mercedes-Benz", "model": "A-Class", "derivative": "A200 AMG Line", "fuel": "Petrol", "trans": "DSG", "years": [2019, 2020, 2021, 2022, 2023]},
    {"make": "Mercedes-Benz", "model": "C-Class", "derivative": "C200 AMG Line", "fuel": "Petrol", "trans": "Automatic", "years": [2019, 2020, 2021, 2022, 2023, 2024]},
    {"make": "Mercedes-Benz", "model": "C-Class", "derivative": "C220d AMG Line", "fuel": "Diesel", "trans": "Automatic", "years": [2020, 2021, 2022, 2023]},
    {"make": "Mercedes-Benz", "model": "GLE", "derivative": "GLE 400d 4MATIC AMG Line", "fuel": "Diesel", "trans": "Automatic", "years": [2020, 2021, 2022, 2023, 2024]},
    {"make": "Mercedes-Benz", "model": "GLC", "derivative": "GLC 300 4MATIC AMG Line", "fuel": "Petrol", "trans": "Automatic", "years": [2020, 2021, 2022, 2023]},

    # ---- Audi ----
    {"make": "Audi", "model": "A3", "derivative": "35 TFSI S line", "fuel": "Petrol", "trans": "DSG", "years": [2020, 2021, 2022, 2023, 2024]},
    {"make": "Audi", "model": "A4", "derivative": "40 TFSI S line quattro", "fuel": "Petrol", "trans": "Automatic", "years": [2019, 2020, 2021, 2022, 2023]},
    {"make": "Audi", "model": "Q5", "derivative": "40 TDI quattro S line", "fuel": "Diesel", "trans": "Automatic", "years": [2020, 2021, 2022, 2023]},
    {"make": "Audi", "model": "e-tron", "derivative": "55 quattro Advanced", "fuel": "Electric", "trans": "Automatic", "years": [2021, 2022, 2023, 2024]},

    # ---- Hyundai ----
    {"make": "Hyundai", "model": "i20", "derivative": "1.2 Motion", "fuel": "Petrol", "trans": "Manual", "years": [2019, 2020, 2021, 2022, 2023, 2024]},
    {"make": "Hyundai", "model": "Tucson", "derivative": "2.0 Elite CRDi", "fuel": "Diesel", "trans": "Automatic", "years": [2020, 2021, 2022, 2023]},
    {"make": "Hyundai", "model": "Creta", "derivative": "1.5 Executive", "fuel": "Petrol", "trans": "Automatic", "years": [2021, 2022, 2023, 2024]},

    # ---- Kia ----
    {"make": "Kia", "model": "Picanto", "derivative": "1.2 Style", "fuel": "Petrol", "trans": "Manual", "years": [2019, 2020, 2021, 2022, 2023]},
    {"make": "Kia", "model": "Sportage", "derivative": "2.0 EX+", "fuel": "Petrol", "trans": "Automatic", "years": [2020, 2021, 2022, 2023]},
    {"make": "Kia", "model": "Seltos", "derivative": "1.5 EX+ CRDi", "fuel": "Diesel", "trans": "Automatic", "years": [2020, 2021, 2022, 2023]},

    # ---- Nissan ----
    {"make": "Nissan", "model": "Navara", "derivative": "2.5 dCi LE 4x4 AT", "fuel": "Diesel", "trans": "Automatic", "years": [2019, 2020, 2021, 2022, 2023]},
    {"make": "Nissan", "model": "Magnite", "derivative": "1.0 Turbo Acenta Plus", "fuel": "Petrol", "trans": "CVT", "years": [2021, 2022, 2023, 2024]},

    # ---- Suzuki ----
    {"make": "Suzuki", "model": "Swift", "derivative": "1.2 GL", "fuel": "Petrol", "trans": "Manual", "years": [2019, 2020, 2021, 2022, 2023, 2024]},
    {"make": "Suzuki", "model": "Baleno", "derivative": "1.4 GLX", "fuel": "Petrol", "trans": "Automatic", "years": [2020, 2021, 2022, 2023]},
    {"make": "Suzuki", "model": "Jimny", "derivative": "1.5 GLX", "fuel": "Petrol", "trans": "Manual", "years": [2019, 2020, 2021, 2022, 2023, 2024]},

    # ---- MINI ----
    {"make": "MINI", "model": "Cooper", "derivative": "3-door Chili", "fuel": "Petrol", "trans": "Automatic", "years": [2020, 2021, 2022, 2023]},
    {"make": "MINI", "model": "Cooper S", "derivative": "3-door Chili", "fuel": "Petrol", "trans": "Automatic", "years": [2020, 2021, 2022, 2023, 2024]},
    {"make": "MINI", "model": "Countryman", "derivative": "Cooper S ALL4", "fuel": "Petrol", "trans": "Automatic", "years": [2020, 2021, 2022, 2023]},

    # ---- Haval ----
    {"make": "Haval", "model": "Jolion", "derivative": "1.5T Super Luxury DCT", "fuel": "Petrol", "trans": "DSG", "years": [2021, 2022, 2023, 2024]},
    {"make": "Haval", "model": "H6", "derivative": "2.0 GDIT Super Luxury 4WD", "fuel": "Petrol", "trans": "DSG", "years": [2022, 2023, 2024]},

    # ---- Tesla ----
    {"make": "Tesla", "model": "Model 3", "derivative": "Long Range AWD", "fuel": "Electric", "trans": "Automatic", "years": [2022, 2023, 2024]},
    {"make": "Tesla", "model": "Model Y", "derivative": "Performance", "fuel": "Electric", "trans": "Automatic", "years": [2022, 2023, 2024]},
]


def expand_specs() -> list[dict]:
    """Flatten `years` list so each row is one make/model/derivative/year combo."""
    out: list[dict] = []
    for row in SEED_SPECS:
        for year in row["years"]:
            out.append({
                "make": row["make"],
                "model": row["model"],
                "derivative": row["derivative"],
                "fuel_type": row["fuel"],
                "transmission": row["trans"],
                "year_of_production": year,
            })
    return out
