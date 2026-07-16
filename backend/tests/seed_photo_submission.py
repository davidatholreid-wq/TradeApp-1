"""Seed a priced submission with the new photo keys for frontend testing."""
import os
import uuid
import requests

BASE = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"
TINY = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

# Register a temp dealer
email = f"seed_photo_{uuid.uuid4().hex[:6]}@example.com"
reg = requests.post(f"{API}/auth/register", json={
    "email": email, "password": "Seed1234!",
    "dealer_info": {"first_name": "Seed", "last_name": "Photo", "phone": "0821112222"},
    "company_info": {"company_name": "TEST_SEED_PHOTO", "company_address": "Test"},
})
print("REG", reg.status_code)
dealer = reg.json()
d_token = dealer["token"]
d_id = dealer["user"]["id"]

# accept agreement
requests.post(f"{API}/agreement/accept", headers={"Authorization": f"Bearer {d_token}"})

# get IDs
makes = requests.get(f"{API}/vehicles/makes").json()["makes"]
bmw = next(m for m in makes if m["name"] == "BMW")
models = requests.get(f"{API}/vehicles/models", params={"make_id": bmw["id"]}).json()["models"]
model = models[0]
derivs = requests.get(f"{API}/vehicles/derivatives", params={"model_id": model["id"]}).json()["derivatives"]
deriv = derivs[0]

payload = {
    "make_id": bmw["id"], "make_name": bmw["name"], "make": bmw["name"],
    "model_id": model["id"], "model_name": model["name"], "model": model["name"],
    "derivative_id": deriv["id"], "derivative_name": deriv["name"], "derivative": deriv["name"],
    "mileage": 45000, "year": 2021, "year_of_production": 2021, "year_registered": 2021,
    "fuel_type": "Petrol", "transmission": "Automatic",
    "factory_warranty": True, "condition": 8,
    "accident_damage": False, "colour": "Black",
    "billing_accepted": True,
    "exterior_condition": 8, "interior_condition": 9, "tyre_condition": 7,
    "windscreen_condition": "Perfect",
    "service_history": "Full Service History with Agents",
    "paint_evidence": False,
    "vin": "WBA5A5C58ED123456",
    "engine_number": "N20B20A123456",
    "last_service_date": "2025-11-15",
    "service_mileage": 40000,
    "reconditioning_items": [{"description": "Front tyres replacement", "amount_zar": 4500}, {"description": "Windscreen chip repair", "amount_zar": 750}],
    "photos": {"front": TINY, "driver_side": TINY, "passenger_side": TINY, "rear": TINY, "interior": TINY},
}
r = requests.post(f"{API}/submissions", json=payload, headers={"Authorization": f"Bearer {d_token}"})
print("SUBMIT", r.status_code, r.text[:200])
sub_id = r.json()["id"]

# Admin login
adm = requests.post(f"{API}/auth/login", json={"email": "admin@fourbuy.co.za", "password": "admin123"}).json()
a_token = adm["token"]

# price it
p = requests.post(f"{API}/admin/submissions/{sub_id}/price", json={"price": 549000, "notes": "TEST seeded"},
                  headers={"Authorization": f"Bearer {a_token}"})
print("PRICE", p.status_code, p.text[:200])
print("SUBMISSION_ID", sub_id)
print("DEALER_EMAIL", email)
print("DEALER_ID", d_id)
