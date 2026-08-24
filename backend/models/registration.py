"""Registration and dealership Pydantic request schemas.

Extracted 2026-08-09 from `backend/server.py` as part of a small,
low-risk file-hygiene pass. These 6 classes are pure request-body
shapes with no runtime logic, so moving them is safe as long as
`server.py` (and any future route modules) re-imports them from here.
"""

from typing import Optional

from pydantic import BaseModel, EmailStr


class DealerInfo(BaseModel):
    first_name: str
    last_name: str
    phone: str
    id_number: Optional[str] = None
    # Job Title (e.g. "Sales Manager", "F&I", "Buyer"). Free text.
    # Optional for backwards compatibility with pre-multi-user users.
    job_title: Optional[str] = None


class CompanyInfo(BaseModel):
    company_name: str
    company_address: str
    company_reg_no: Optional[str] = None
    vat_no: Optional[str] = None
    # Accounts contact — the person at the dealership who receives
    # billing correspondence (invoices, statements, deposit requests).
    # All three fields are optional at registration so the sign-up flow
    # stays lightweight; the admin can top them up later in the Billing
    # section. Aug 2026.
    accounts_contact_name: Optional[str] = None
    accounts_contact_phone: Optional[str] = None
    accounts_contact_email: Optional[str] = None


class RegisterRequest(BaseModel):
    """Public register — always creates a brand new Dealership plus the
    first user (who becomes a regular dealer user, not an owner because
    all users of a dealership are equal per product spec)."""
    email: EmailStr
    password: str
    dealer_info: DealerInfo
    company_info: CompanyInfo


class AdminInviteUserRequest(BaseModel):
    """Admin creates a new user inside an existing dealership."""
    email: EmailStr
    password: str
    dealer_info: DealerInfo
    active: bool = True
    # South African ID Number — required for every new dealer account so
    # we have a verifiable identity for compliance / billing purposes.
    sa_id_number: str
    # Optional referral code — if the new dealer applied via another
    # dealer's referral link, admin keys the code here and we link the
    # accounts so the referrer earns matching TradeAPP Rewards points.
    referred_by_code: Optional[str] = None


class DealershipUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    company_reg_no: Optional[str] = None
    vat_no: Optional[str] = None
    active: Optional[bool] = None
    # ---- Company invoice details ---------------------------------------
    # Optional metadata the dealership can populate themselves via the
    # Profile screen so we can render an un-branded "Company Invoice
    # Details" PDF they can hand to suppliers or customers. Every field
    # is a plain string — no validation beyond max-length in the mongo
    # layer, because these are pure display strings.
    contact_person: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    website: Optional[str] = None
    bank_name: Optional[str] = None
    bank_account_holder: Optional[str] = None
    bank_account_no: Optional[str] = None
    bank_branch_code: Optional[str] = None
    bank_account_type: Optional[str] = None
    bank_swift: Optional[str] = None
    invoice_notes: Optional[str] = None
    # Accounts contact — the person at the dealership who receives
    # monthly invoices, statements and deposit requests. Editable by
    # admin from the Billing screen. Aug 2026.
    accounts_contact_name: Optional[str] = None
    accounts_contact_phone: Optional[str] = None
    accounts_contact_email: Optional[str] = None


class DealershipCreate(BaseModel):
    """Admin creates a brand-new dealership from the admin cockpit.
    Only `name` is truly required — the rest are optional metadata that
    we can fill in later via PATCH /admin/dealerships/{id}."""
    name: str
    address: Optional[str] = ""
    company_reg_no: Optional[str] = None
    vat_no: Optional[str] = None
    active: bool = True
    # Optional accounts contact at create time — pre-populates the
    # dealership doc so the admin doesn't have to open a second dialog
    # to key it in.
    accounts_contact_name: Optional[str] = None
    accounts_contact_phone: Optional[str] = None
    accounts_contact_email: Optional[str] = None


__all__ = [
    "DealerInfo",
    "CompanyInfo",
    "RegisterRequest",
    "AdminInviteUserRequest",
    "DealershipUpdate",
    "DealershipCreate",
]
